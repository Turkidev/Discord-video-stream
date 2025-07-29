import { EventEmitter } from 'node:events';
import { PassThrough, Transform } from 'node:stream';
import type { VideoStream } from './VideoStream.js';
import type { AudioStream } from './AudioStream.js';
import type { Packet } from '@lng2004/libav.js-variant-webcodecs-avf-with-decoders';
import { combineLoHi } from './utils.js';

export class SeekableMediaController extends EventEmitter {
    private videoStream?: VideoStream;
    private audioStream?: AudioStream;
    private videoTransform: Transform;
    private audioTransform: Transform;
    private isKeyFrameCache = new Map<number, boolean>();
    private keyFramePositions: number[] = [];
    private currentPosition = 0;
    
    constructor() {
        super();
        
        // Create transform streams that can intercept packets
        this.videoTransform = new Transform({
            objectMode: true,
            transform: (packet: Packet, _, callback) => {
                this.processVideoPacket(packet, callback);
            }
        });
        
        this.audioTransform = new Transform({
            objectMode: true,
            transform: (packet: Packet, _, callback) => {
                this.processAudioPacket(packet, callback);
            }
        });
    }
    
    public attachStreams(videoStream: VideoStream, audioStream?: AudioStream) {
        this.videoStream = videoStream;
        this.audioStream = audioStream;
        
        // Pipe through our transform streams
        this.videoTransform.pipe(videoStream);
        if (audioStream) {
            this.audioTransform.pipe(audioStream);
        }
    }
    
    private processVideoPacket(packet: Packet, callback: Function) {
        const pts = combineLoHi(packet.ptshi!, packet.pts!) / 
                   packet.time_base_den! * packet.time_base_num! * 1000;
        
        // Check if this is a keyframe (simplified - you'd need codec-specific logic)
        const isKeyFrame = (packet.flags !== undefined && packet.flags & 0x0001) !== 0;
        
        if (isKeyFrame) {
            this.isKeyFrameCache.set(pts, true);
            this.keyFramePositions.push(pts);
            this.keyFramePositions.sort((a, b) => a - b);
        }
        
        this.currentPosition = pts;
        callback(null, packet);
    }
    
    private processAudioPacket(packet: Packet, callback: Function) {
        callback(null, packet);
    }
    
    public async seek(targetMs: number): Promise<void> {
        // Find the nearest keyframe before the target position
        const nearestKeyFrame = this.findNearestKeyFrame(targetMs);
        
        // Emit seek event to notify the demuxer
        this.emit('seek', nearestKeyFrame);
        
        // Update streams to handle the seek
        if (this.videoStream) {
            (this.videoStream as any).seek(targetMs);
        }
        if (this.audioStream) {
            (this.audioStream as any).seek(targetMs);
        }
    }
    
    private findNearestKeyFrame(targetMs: number): number {
        // Find the closest keyframe before the target
        let nearest = 0;
        for (const keyFramePos of this.keyFramePositions) {
            if (keyFramePos <= targetMs) {
                nearest = keyFramePos;
            } else {
                break;
            }
        }
        return nearest;
    }
    
    public get videoInput() {
        return this.videoTransform;
    }
    
    public get audioInput() {
        return this.audioTransform;
    }
}
