import { Log } from "debug-level";
import { setTimeout } from "node:timers/promises";
import { Writable } from "node:stream";
import { combineLoHi } from "./utils.js";
import type { Packet } from "@lng2004/libav.js-variant-webcodecs-avf-with-decoders";

export class BaseMediaStream extends Writable {
    private _pts?: number;
    private _syncTolerance = 20;
    private _loggerSend: Log;
    private _loggerSync: Log;
    private _loggerSleep: Log;
    private _loggerSeek: Log;

    private _noSleep: boolean;
    private _startTime?: number;
    private _startPts?: number;
    private _sync = true;
    private _syncStream?: BaseMediaStream;
    
    // New properties for seeking
    private _seekOffset = 0;
    private _isSeeking = false;
    private _seekTarget?: number;
    private _virtualPts = 0;
    private _lastRealPts = 0;

    constructor(type: string, noSleep = false) {
        super({ objectMode: true, highWaterMark: 0 });
        this._loggerSend = new Log(`stream:${type}:send`);
        this._loggerSync = new Log(`stream:${type}:sync`);
        this._loggerSleep = new Log(`stream:${type}:sleep`);
        this._loggerSeek = new Log(`stream:${type}:seek`);
        this._noSleep = noSleep;
    }

    get sync(): boolean {
        return this._sync;
    }
    set sync(val: boolean) {
        this._sync = val;
        if (val)
            this._loggerSync.debug("Sync enabled");
        else
            this._loggerSync.debug("Sync disabled");
    }
    get syncStream() {
        return this._syncStream;
    }
    set syncStream(stream: BaseMediaStream | undefined)
    {
        if (stream !== undefined && this === stream.syncStream)
            throw new Error("Cannot sync 2 streams with eachother");
        this._syncStream = stream;
    }
    get noSleep(): boolean {
        return this._noSleep;
    }
    set noSleep(val: boolean) {
        this._noSleep = val;
        if (!val)
            this.resetTimingCompensation();
    }
    get pts(): number | undefined {
        return this._pts;
    }
    get syncTolerance() {
        return this._syncTolerance;
    }
    set syncTolerance(n: number) {
        if (n < 0)
            return;
        this._syncTolerance = n;
    }
    protected async _sendFrame(frame: Buffer, frametime: number): Promise<void>
    {
        throw new Error("Not implemented");
    }
    private ptsDelta() {
        if (this.pts !== undefined && this.syncStream?.pts !== undefined)
            return this.pts - this.syncStream.pts;
        return undefined;
    }
    private isAhead() {
        const delta = this.ptsDelta();
        return this.syncStream?.writableEnded === false && delta !== undefined && delta > this.syncTolerance;
    }
    private isBehind() {
        const delta = this.ptsDelta();
        return this.syncStream?.writableEnded === false && delta !== undefined && delta < -this.syncTolerance;
    }
    private resetTimingCompensation() {
        this._startTime = this._startPts = undefined;
    }
    public seek(targetPts: number) {
        this._loggerSeek.debug({ targetPts }, "Seeking to position");
        this._isSeeking = true;
        this._seekTarget = targetPts;
        this._seekOffset = targetPts - (this._lastRealPts || 0);
        this.resetTimingCompensation();
    }

    async _write(frame: Packet, _: BufferEncoding, callback: (error?: Error | null) => void) {
        const { data, ptshi, pts, durationhi, duration, time_base_num, time_base_den } = frame;
        const frametime = combineLoHi(durationhi!, duration!) / time_base_den! * time_base_num! * 1000;
        
        // Calculate real PTS
        const realPts = combineLoHi(ptshi!, pts!) / time_base_den! * time_base_num! * 1000;
        this._lastRealPts = realPts;

        // Handle seeking
        if (this._isSeeking && this._seekTarget !== undefined) {
            // Skip frames until we reach the seek target
            if (realPts < this._seekTarget) {
                this._loggerSeek.trace({ realPts, seekTarget: this._seekTarget }, "Skipping frame during seek");
                callback(null);
                return;
            }
            // We've reached the seek target
            this._isSeeking = false;
            this._seekTarget = undefined;
            this._loggerSeek.debug({ realPts }, "Seek completed");
        }

        // Calculate virtual PTS (what Discord thinks is the current position)
        this._virtualPts += frametime;
        this._pts = this._virtualPts;

        const start_sendFrame = performance.now();
        await this._sendFrame(Buffer.from(data), frametime);
        const end_sendFrame = performance.now();

        this.emit("pts", this._pts);

        // Rest of the timing logic remains the same...
        const sendTime = end_sendFrame - start_sendFrame;
        const ratio = sendTime / frametime;
        this._loggerSend.debug({
            stats: {
                pts: this._pts,
                realPts,
                virtualPts: this._virtualPts,
                frame_size: data.length,
                duration: sendTime,
                frametime
            }
        }, `Frame sent in ${sendTime.toFixed(2)}ms (${(ratio * 100).toFixed(2)}% frametime)`);

        // Sleep calculations use virtual PTS
        this._startTime ??= start_sendFrame;
        this._startPts ??= this._virtualPts;
        const sleep = Math.max(
            0, this._virtualPts - this._startPts + frametime - (end_sendFrame - this._startTime)
        );
        if (ratio > 1)
        {
            this._loggerSend.warn({
                frame_size: data.length,
                duration: sendTime,
                frametime
            }, `Frame takes too long to send (${(ratio * 100).toFixed(2)}% frametime)`)
        }

        this._startTime ??= start_sendFrame;
        this._startPts ??= this._pts;
        const sleep = Math.max(
            0, this._pts - this._startPts + frametime - (end_sendFrame - this._startTime)
        );
        if (this._noSleep || sleep === 0)
        {
            callback(null);
        }
        else if (this.sync && this.isBehind())
        {
            this._loggerSync.debug({
                stats: {
                    pts: this.pts,
                    pts_other: this.syncStream?.pts
                }
            }, "Stream is behind. Not sleeping for this frame");
            this.resetTimingCompensation();
            callback(null);
        }
        else if (this.sync && this.isAhead())
        {
            do
            {
                this._loggerSync.debug({
                    stats: {
                        pts: this.pts,
                        pts_other: this.syncStream?.pts,
                        frametime
                    }
                }, `Stream is ahead. Waiting for ${frametime}ms`);
                await setTimeout(frametime);
            }
            while (this.sync && this.isAhead());
            this.resetTimingCompensation();
            callback(null);
        }
        else
        {
            this._loggerSleep.debug({
                stats: {
                    pts: this._pts,
                    startPts: this._startPts,
                    time: end_sendFrame,
                    startTime: this._startTime,
                    frametime
                }
            }, `Sleeping for ${sleep}ms`);
            setTimeout(sleep).then(() => callback(null));
        }
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        super._destroy(error, callback);
        this.syncStream = undefined;
    }
}
