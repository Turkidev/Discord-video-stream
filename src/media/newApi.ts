import ffmpeg from 'fluent-ffmpeg';
import pDebounce from 'p-debounce';
import sharp from 'sharp';
import Log from 'debug-level';
import * as zmq from "zeromq";
import { PassThrough, Transform, type Readable } from "node:stream";
import { demux } from './LibavDemuxer.js';
import { VideoStream } from './VideoStream.js';
import { AudioStream } from './AudioStream.js';
import { isFiniteNonZero } from '../utils.js';
import { AVCodecID } from './LibavCodecId.js';
import { createDecoder } from './LibavDecoder.js';
import { combineLoHi } from './utils.js';

import LibAV from '@lng2004/libav.js-variant-webcodecs-avf-with-decoders';
import type { SupportedVideoCodec } from '../utils.js';
import type { MediaUdp, Streamer } from '../client/index.js';
import type { Packet } from '@lng2004/libav.js-variant-webcodecs-avf-with-decoders';

export type EncoderOptions = {
    /**
     * Disable video transcoding
     * If enabled, all video related settings have no effects, and the input
     * video stream is used as-is.
     * 
     * You need to ensure that the video stream has the right properties
     * (keyframe every 1s, B-frames disabled). Failure to do so will result in
     * a glitchy stream, or degraded performance
     */
    noTranscoding: boolean,

    /**
     * Video width
     */
    width: number,

    /**
     * Video height
     */
    height: number,

    /**
     * Video frame rate
     */
    frameRate?: number,

    /**
     * Video codec
     */
    videoCodec: SupportedVideoCodec,

    /**
     * Video average bitrate in kbps
     */
    bitrateVideo: number,

    /**
     * Video max bitrate in kbps
     */
    bitrateVideoMax: number,

    /**
     * Audio bitrate in kbps
     */
    bitrateAudio: number,

    /**
     * Enable audio output
     */
    includeAudio: boolean,

    /**
     * Enable hardware accelerated decoding
     */
    hardwareAcceleratedDecoding: boolean,

    /**
     * Add some options to minimize latency
     */
    minimizeLatency: boolean,

    /**
     * Preset for x264 and x265
     */
    h26xPreset: "ultrafast" | "superfast" | "veryfast" | "faster" | "fast" | "medium" | "slow" | "slower" | "veryslow" | "placebo",

    /**
     * Custom headers for HTTP requests
     */
    customHeaders: Record<string, string>,

    /**
     * Custom ffmpeg flags/options to pass directly to ffmpeg
     * These will be added to the command after other options
     */
    customFfmpegFlags: string[]
}

export type Controller = {
    volume: number,
    setVolume(newVolume: number): Promise<boolean>
};

// Seekable Stream Controller for enhanced functionality
class SeekableStreamController extends Transform {
    private keyFramePositions: number[] = [];
    private currentPts = 0;
    private seekTarget?: number;
    private isSeeking = false;
    
    constructor() {
        super({ objectMode: true });
    }
    
    _transform(packet: Packet, encoding: string, callback: Function) {
        const pts = combineLoHi(packet.ptshi!, packet.pts!) / 
                   packet.time_base_den! * packet.time_base_num! * 1000;
        
        this.currentPts = pts;
        
        // Track keyframes
        const isKeyFrame = (packet.flags !== undefined && packet.flags & 0x0001) !== 0;
        if (isKeyFrame) {
            this.keyFramePositions.push(pts);
        }
        
        // Handle seeking
        if (this.isSeeking && this.seekTarget !== undefined) {
            if (pts < this.seekTarget) {
                // Skip frames until we reach the seek target
                callback();
                return;
            }
            this.isSeeking = false;
            this.seekTarget = undefined;
        }
        
        callback(null, packet);
    }
    
    seek(targetMs: number) {
        this.seekTarget = targetMs;
        this.isSeeking = true;
        this.emit('seek', targetMs);
    }
    
    getCurrentPosition() {
        return this.currentPts;
    }
}

export function prepareStream(
    input: string | Readable,
    options: Partial<EncoderOptions> = {},
    cancelSignal?: AbortSignal
) {
    cancelSignal?.throwIfAborted();
    const defaultOptions = {
        noTranscoding: false,
        // negative values = resize by aspect ratio, see https://trac.ffmpeg.org/wiki/Scaling
        width: -2,
        height: -2,
        frameRate: undefined,
        videoCodec: "H264",
        bitrateVideo: 5000,
        bitrateVideoMax: 7000,
        bitrateAudio: 128,
        includeAudio: true,
        hardwareAcceleratedDecoding: false,
        minimizeLatency: false,
        h26xPreset: "ultrafast",
        customHeaders: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.3",
            "Connection": "keep-alive",
        },
        customFfmpegFlags: []
    } satisfies EncoderOptions;

    function mergeOptions(opts: Partial<EncoderOptions>) {
        return {
            noTranscoding:
                opts.noTranscoding ?? defaultOptions.noTranscoding,

            width:
                isFiniteNonZero(opts.width) ? Math.round(opts.width) : defaultOptions.width,

            height:
                isFiniteNonZero(opts.height) ? Math.round(opts.height) : defaultOptions.height,

            frameRate:
                isFiniteNonZero(opts.frameRate) && opts.frameRate > 0
                    ? opts.frameRate
                    : defaultOptions.frameRate,

            videoCodec:
                opts.videoCodec ?? defaultOptions.videoCodec,

            bitrateVideo:
                isFiniteNonZero(opts.bitrateVideo) && opts.bitrateVideo > 0
                    ? Math.round(opts.bitrateVideo)
                    : defaultOptions.bitrateVideo,

            bitrateVideoMax:
                isFiniteNonZero(opts.bitrateVideoMax) && opts.bitrateVideoMax > 0
                    ? Math.round(opts.bitrateVideoMax)
                    : defaultOptions.bitrateVideoMax,

            bitrateAudio:
                isFiniteNonZero(opts.bitrateAudio) && opts.bitrateAudio > 0
                    ? Math.round(opts.bitrateAudio)
                    : defaultOptions.bitrateAudio,

            includeAudio:
                opts.includeAudio ?? defaultOptions.includeAudio,

            hardwareAcceleratedDecoding:
                opts.hardwareAcceleratedDecoding ?? defaultOptions.hardwareAcceleratedDecoding,

            minimizeLatency:
                opts.minimizeLatency ?? defaultOptions.minimizeLatency,

            h26xPreset:
                opts.h26xPreset ?? defaultOptions.h26xPreset,

            customHeaders: {
                ...defaultOptions.customHeaders, ...opts.customHeaders
            },

            customFfmpegFlags:
                opts.customFfmpegFlags ?? defaultOptions.customFfmpegFlags
        } satisfies EncoderOptions
    }

    const mergedOptions = mergeOptions(options);

    let isHttpUrl = false;
    let isHls = false;

    if (typeof input === "string") {
        isHttpUrl = input.startsWith('http') || input.startsWith('https');
        isHls = input.includes('m3u');
    }

    const output = new PassThrough();

    // command creation
    const command = ffmpeg(input)
        .addOption('-loglevel', '0')

    // input options
    const { hardwareAcceleratedDecoding, minimizeLatency, customHeaders } = mergedOptions;
    if (hardwareAcceleratedDecoding)
        command.inputOption('-hwaccel', 'auto');

    if (minimizeLatency) {
        command.addOptions([
            '-fflags nobuffer',
            '-analyzeduration 0'
        ])
    }

    if (isHttpUrl) {
        command.inputOption('-headers',
            Object.entries(customHeaders).map(([k, v]) => `${k}: ${v}`).join("\r\n")
        );
        if (!isHls) {
            command.inputOptions([
                '-reconnect 1',
                '-reconnect_at_eof 1',
                '-reconnect_streamed 1',
                '-reconnect_delay_max 4294'
            ]);
        }
    }

    // general output options
    command
        .output(output)
        .outputFormat("matroska");

    // video setup
    const {
        noTranscoding, width, height, frameRate, bitrateVideo, bitrateVideoMax, videoCodec, h26xPreset
    } = mergedOptions;
    command.addOutputOption("-map 0:v");

    if (noTranscoding)
    {
        command.videoCodec("copy");
    }
    else
    {
        command.videoFilter(`scale=${width}:${height}`)

        if (frameRate)
            command.fpsOutput(frameRate);

        command.addOutputOption([
            "-b:v", `${bitrateVideo}k`,
            "-maxrate:v", `${bitrateVideoMax}k`,
            "-bf", "0",
            "-pix_fmt", "yuv420p",
            "-force_key_frames", "expr:gte(t,n_forced*1)"
        ]);

        switch (videoCodec) {
            case 'AV1':
                command
                    .videoCodec("libsvtav1")
                break;
            case 'VP8':
                command
                    .videoCodec("libvpx")
                    .outputOption('-deadline', 'realtime');
                break;
            case 'VP9':
                command
                    .videoCodec("libvpx-vp9")
                    .outputOption('-deadline', 'realtime');
                break;
            case 'H264':
                command
                    .videoCodec("libx264")
                    .outputOptions([
                        '-tune zerolatency',
                        `-preset ${h26xPreset}`,
                        '-profile:v baseline',
                    ]);
                break;
            case 'H265':
                command
                    .videoCodec("libx265")
                    .outputOptions([
                        '-tune zerolatency',
                        `-preset ${h26xPreset}`,
                        '-profile:v main',
                    ]);
                break;
        }
    }

    // audio setup
    const { includeAudio, bitrateAudio } = mergedOptions;
    if (includeAudio)
        command
            .addOutputOption("-map 0:a?")
            .audioChannels(2)
            /*
             * I don't have much surround sound material to test this with,
             * if you do and you have better settings for this, feel free to
             * contribute!
             */
            .addOutputOption("-lfe_mix_level 1")
            .audioFrequency(48000)
            .audioCodec("libopus")
            .audioBitrate(`${bitrateAudio}k`)
            .audioFilters("volume@internal_lib=1.0")

    // Add custom ffmpeg flags
    if (mergedOptions.customFfmpegFlags && mergedOptions.customFfmpegFlags.length > 0) {
        command.addOptions(mergedOptions.customFfmpegFlags);
    }

    // realtime control mechanism
    const zmqAudio = "tcp://localhost:42069";
    const zmqAudioClient = new zmq.Request({ sendTimeout: 5000, receiveTimeout: 5000 });

    if (includeAudio)
    {
        command.audioFilters(`azmq=b=${zmqAudio.replaceAll(":","\\\\:")}`)
        output.once("data", () => {
            zmqAudioClient.connect(zmqAudio);
        });
    }

    // exit handling
    const promise = new Promise<void>((resolve, reject) => {
        command.on("error", (err) => {
            if (cancelSignal?.aborted)
                /**
                 * fluent-ffmpeg might throw an error when SIGTERM is sent to
                 * the process, so we check if the abort signal is triggered
                 * and throw that instead
                 */
                reject(cancelSignal.reason);
            else
                reject(err);
        });
        command.on("end", () => resolve());
    })
    promise.catch(() => {});
    cancelSignal?.addEventListener("abort", () => command.kill("SIGTERM"), { once: true });
    command.run();

    let currentVolume = 1;
    return {
        command,
        output,
        promise,
        controller: {
            get volume() {
                return currentVolume;
            },
            async setVolume(newVolume: number)
            {
                if (newVolume < 0)
                    return false;
                try
                {
                    await zmqAudioClient.send(`volume@internal_lib volume ${newVolume}`);
                    const [res] = await zmqAudioClient.receive();
                    if (res.toString("utf-8") !== "0 Error number 0 occurred")
                        return false;
                    currentVolume = newVolume;
                    return true;
                }
                catch
                {
                    return false;
                }
            }
        } satisfies Controller
    }
}

// Enhanced prepareStream with seek support
export function prepareSeekableStream(
    input: string,
    options: Partial<EncoderOptions> = {},
    cancelSignal?: AbortSignal
) {
    if (typeof input !== 'string') {
        throw new Error('Seekable streams require a file path or URL input');
    }

    let currentCommand: ffmpeg.FfmpegCommand | null = null;
    const output = new PassThrough();
    let startTime = 0;

    const createCommand = (seekTime = 0) => {
        // Kill previous command if exists
        if (currentCommand) {
            currentCommand.kill('SIGTERM');
        }

        startTime = seekTime;
        const { command, controller } = prepareStream(input, options, cancelSignal);
        
        // Add seek input option
        command.seekInput(seekTime / 1000);
        
        currentCommand = command;
        return { command, controller };
    };

    // Start initial stream
    const { controller: initialController } = createCommand(0);

    const seekController = {
        ...initialController,
        async seek(timeMs: number) {
            const { controller } = createCommand(timeMs);
            // Transfer the current volume setting
            if (initialController.volume !== 1) {
                await controller.setVolume(initialController.volume);
            }
            return controller;
        },
        getCurrentTime() {
            return startTime;
        }
    };

    return {
        command: currentCommand!,
        output,
        controller: seekController
    };
}

export type PlayStreamOptions = {
    /**
     * Set stream type as "Go Live" or camera stream
     */
    type: "go-live" | "camera",

    /**
     * Override video width sent to Discord.
     * 
     * DO NOT SPECIFY UNLESS YOU KNOW WHAT YOU'RE DOING!
     */
    width: number,

    /**
     * Override video height sent to Discord.
     * 
     * DO NOT SPECIFY UNLESS YOU KNOW WHAT YOU'RE DOING!
     */
    height: number,

    /**
     * Override video frame rate sent to Discord.
     * 
     * DO NOT SPECIFY UNLESS YOU KNOW WHAT YOU'RE DOING!
     */
    frameRate: number,

    /**
     * Same as ffmpeg's `readrate_initial_burst` command line flag
     * 
     * See https://ffmpeg.org/ffmpeg.html#:~:text=%2Dreadrate_initial_burst
     */
    readrateInitialBurst: number | undefined,

    /**
     * Enable stream preview from input stream (experimental)
     */
    streamPreview: boolean,
}

export type StreamController = {
    seek(timeMs: number): Promise<void>;
    getCurrentPosition(): number;
    pause(): void;
    resume(): void;
    isPaused(): boolean;
}

export async function playStream(
    input: Readable, streamer: Streamer,
    options: Partial<PlayStreamOptions> = {},
    cancelSignal?: AbortSignal
): Promise<void>
{
    const logger = new Log("playStream");
    cancelSignal?.throwIfAborted();
    if (!streamer.voiceConnection)
        throw new Error("Bot is not connected to a voice channel");

    logger.debug("Initializing demuxer");
    const { video, audio } = await demux(input);
    cancelSignal?.throwIfAborted();

    if (!video)
        throw new Error("No video stream in media");

    const cleanupFuncs: (() => unknown)[] = [];
    const videoCodecMap: Record<number, SupportedVideoCodec> = {
        [AVCodecID.AV_CODEC_ID_H264]: "H264",
        [AVCodecID.AV_CODEC_ID_H265]: "H265",
        [AVCodecID.AV_CODEC_ID_VP8]: "VP8",
        [AVCodecID.AV_CODEC_ID_VP9]: "VP9",
        [AVCodecID.AV_CODEC_ID_AV1]: "AV1"
    }
    const defaultOptions = {
        type: "go-live",
        width: video.width,
        height: video.height,
        frameRate: video.framerate_num / video.framerate_den,
        readrateInitialBurst: undefined,
        streamPreview: false,
    } satisfies PlayStreamOptions;

    function mergeOptions(opts: Partial<PlayStreamOptions>)
    {
        return {
            type:
                opts.type ?? defaultOptions.type,

            width:
                isFiniteNonZero(opts.width) && opts.width > 0
                    ? Math.round(opts.width)
                    : defaultOptions.width,

            height:
                isFiniteNonZero(opts.height) && opts.height > 0
                    ? Math.round(opts.height)
                    : defaultOptions.height,

            frameRate: Math.round(
                isFiniteNonZero(opts.frameRate) && opts.frameRate > 0
                    ? Math.round(opts.frameRate)
                    : defaultOptions.frameRate
            ),

            readrateInitialBurst:
                isFiniteNonZero(opts.readrateInitialBurst) && opts.readrateInitialBurst > 0
                    ? opts.readrateInitialBurst
                    : defaultOptions.readrateInitialBurst,

            streamPreview:
                opts.streamPreview ?? defaultOptions.streamPreview,
        } satisfies PlayStreamOptions
    }

    const mergedOptions = mergeOptions(options);
    logger.debug({ options: mergedOptions }, "Merged options");

    let udp: MediaUdp;
    let stopStream: () => unknown;
    if (mergedOptions.type === "go-live")
    {
        udp = await streamer.createStream();
        stopStream = () => streamer.stopStream();
    }
    else
    {
        udp = streamer.voiceConnection.udp;
        streamer.signalVideo(true);
        stopStream = () => streamer.signalVideo(false);
    }
    udp.setPacketizer(videoCodecMap[video.codec]);
    udp.mediaConnection.setSpeaking(true);
    udp.mediaConnection.setVideoAttributes(true, {
        width: mergedOptions.width,
        height: mergedOptions.height,
        fps: mergedOptions.frameRate
    });

    const vStream = new VideoStream(udp);
    video.stream.pipe(vStream);
    if (audio)
    {
        const aStream = new AudioStream(udp);
        audio.stream.pipe(aStream);
        vStream.syncStream = aStream;

        const burstTime = mergedOptions.readrateInitialBurst;
        if (typeof burstTime === "number")
        {
            vStream.sync = false;
            vStream.noSleep = aStream.noSleep = true;
            const stopBurst = (pts: number) => {
                if (pts < burstTime * 1000)
                    return;
                vStream.sync = true;
                vStream.noSleep = aStream.noSleep = false;
                vStream.off("pts", stopBurst);
            }
            vStream.on("pts", stopBurst);
        }
    }
    if (mergedOptions.streamPreview && mergedOptions.type === "go-live")
    {
        (async () => {
            const logger = new Log("playStream:preview");
            logger.debug("Initializing decoder for stream preview");
            const decoder = await createDecoder(video.codec, video.codecpar);
            if (!decoder)
            {
                logger.warn("Failed to initialize decoder. Stream preview will be disabled");
                return;
            }
            cleanupFuncs.push(() => {
                logger.debug("Freeing decoder");
                decoder.free();
            });
            const updatePreview = pDebounce.promise(async (packet: LibAV.Packet) => {
                if (!(packet.flags !== undefined && packet.flags & LibAV.AV_PKT_FLAG_KEY))
                    return;
                const decodeStart = performance.now();
                const [frame] = await decoder.decode([packet]).catch(() => []);
                if (!frame)
                    return;
                const decodeEnd = performance.now();
                logger.debug(`Decoding a frame took ${decodeEnd - decodeStart}ms`);

                return sharp(frame.data, {
                    raw: {
                        width: frame.width ?? 0,
                        height: frame.height ?? 0,
                        channels: 4
                    }
                })
                .resize(1024, 576, { fit: "inside" })
                .jpeg()
                .toBuffer()
                .then(image => streamer.setStreamPreview(image))
                .catch(() => {});
            });
            video.stream.on("data", updatePreview);
            cleanupFuncs.push(() => video.stream.off("data", updatePreview));
        })();
    }
    return new Promise<void>((resolve, reject) => {
        cleanupFuncs.push(() => {
            stopStream();
            udp.mediaConnection.setSpeaking(false);
            udp.mediaConnection.setVideoAttributes(false);
        });
        let cleanedUp = false;
        const cleanup = () => {
            if (cleanedUp)
                return;
            cleanedUp = true;
            for (const f of cleanupFuncs)
                f();
        }
        cancelSignal?.addEventListener("abort", () => {
            cleanup();
            reject(cancelSignal.reason);
        }, { once: true })
        vStream.once("finish", () => {
            if (cancelSignal?.aborted)
                return;
            cleanup();
            resolve();
        });
    }).catch(() => {});
}

// New enhanced playStream with seek support
export async function playSeekableStream(
    input: string | Readable,
    streamer: Streamer,
    options: Partial<PlayStreamOptions> = {},
    cancelSignal?: AbortSignal
): Promise<StreamController> {
    const logger = new Log("playSeekableStream");
    cancelSignal?.throwIfAborted();
    
    if (!streamer.voiceConnection)
        throw new Error("Bot is not connected to a voice channel");

    // Create seekable stream controllers
    const videoSeekController = new SeekableStreamController();
    const audioSeekController = new SeekableStreamController();
    
    let isPaused = false;
    let currentPosition = 0;
    
    // If input is a string, we can support seeking by restarting FFmpeg
    let seekableInput: Readable;
    let ffmpegSeekHandler: ((timeMs: number) => Promise<void>) | undefined;
    
    if (typeof input === 'string') {
        // Create a seekable FFmpeg stream
        const output = new PassThrough();
        let currentCommand: ffmpeg.FfmpegCommand | null = null;
        
        const createSeekableCommand = (seekTime = 0) => {
            if (currentCommand) {
                currentCommand.kill('SIGTERM');
            }
            
            const { command } = prepareStream(input, options, cancelSignal);
            command.seekInput(seekTime / 1000);
            command.pipe(output, { end: false });
            currentCommand = command;
        };
        
        createSeekableCommand(0);
        seekableInput = output;
        
        ffmpegSeekHandler = async (timeMs: number) => {
            logger.debug({ timeMs }, "FFmpeg seeking to position");
            createSeekableCommand(timeMs);
        };
    } else {
        seekableInput = input;
    }

    logger.debug("Initializing demuxer");
    const { video, audio } = await demux(seekableInput);
    cancelSignal?.throwIfAborted();

    if (!video)
        throw new Error("No video stream in media");

    const cleanupFuncs: (() => unknown)[] = [];
    const videoCodecMap: Record<number, SupportedVideoCodec> = {
        [AVCodecID.AV_CODEC_ID_H264]: "H264",
        [AVCodecID.AV_CODEC_ID_H265]: "H265",
        [AVCodecID.AV_CODEC_ID_VP8]: "VP8",
        [AVCodecID.AV_CODEC_ID_VP9]: "VP9",
        [AVCodecID.AV_CODEC_ID_AV1]: "AV1"
    };

    const defaultOptions = {
        type: "go-live",
        width: video.width,
        height: video.height,
        frameRate: video.framerate_num / video.framerate_den,
        readrateInitialBurst: undefined,
        streamPreview: false,
    } satisfies PlayStreamOptions;

    function mergeOptions(opts: Partial<PlayStreamOptions>) {
        return {
            type: opts.type ?? defaultOptions.type,
            width: isFiniteNonZero(opts.width) && opts.width > 0
                ? Math.round(opts.width)
                : defaultOptions.width,
            height: isFiniteNonZero(opts.height) && opts.height > 0
                ? Math.round(opts.height)
                : defaultOptions.height,
            frameRate: Math.round(
                isFiniteNonZero(opts.frameRate) && opts.frameRate > 0
                    ? Math.round(opts.frameRate)
                    : defaultOptions.frameRate
            ),
            readrateInitialBurst: isFiniteNonZero(opts.readrateInitialBurst) && opts.readrateInitialBurst > 0
                ? opts.readrateInitialBurst
                : defaultOptions.readrateInitialBurst,
            streamPreview: opts.streamPreview ?? defaultOptions.streamPreview,
        } satisfies PlayStreamOptions;
    }

    const mergedOptions = mergeOptions(options);
    logger.debug({ options: mergedOptions }, "Merged options");

    let udp: MediaUdp;
    let stopStream: () => unknown;
    if (mergedOptions.type === "go-live") {
        udp = await streamer.createStream();
        stopStream = () => streamer.stopStream();
    } else {
        udp = streamer.voiceConnection.udp;
        streamer.signalVideo(true);
        stopStream = () => streamer.signalVideo(false);
    }
    
    udp.setPacketizer(videoCodecMap[video.codec]);
    udp.mediaConnection.setSpeaking(true);
    udp.mediaConnection.setVideoAttributes(true, {
        width: mergedOptions.width,
        height: mergedOptions.height,
        fps: mergedOptions.frameRate
    });

    const vStream = new VideoStream(udp);
    const aStream = audio ? new AudioStream(udp) : undefined;

    // Pipe through seek controllers
    video.stream.pipe(videoSeekController).pipe(vStream);
    if (audio && aStream) {
        audio.stream.pipe(audioSeekController).pipe(aStream);
        vStream.syncStream = aStream;
    }

    // Track current position
    videoSeekController.on('data', (packet: Packet) => {
        currentPosition = videoSeekController.getCurrentPosition();
    });

    // Handle seek events
    if (ffmpegSeekHandler) {
        videoSeekController.on('seek', ffmpegSeekHandler);
        audioSeekController.on('seek', ffmpegSeekHandler);
    }

    // Stream controller
    const controller: StreamController = {
        async seek(timeMs: number) {
            logger.debug({ timeMs }, "Seeking to position");
            videoSeekController.seek(timeMs);
            if (audio) {
                audioSeekController.seek(timeMs);
            }
        },
        getCurrentPosition() {
            return currentPosition;
        },
        pause() {
            isPaused = true;
            vStream.pause();
            aStream?.pause();
        },
        resume() {
            isPaused = false;
            vStream.resume();
            aStream?.resume();
        },
        isPaused() {
            return isPaused;
        }
    };

    // Handle cleanup
    const cleanup = new Promise<void>((resolve, reject) => {
        cleanupFuncs.push(() => {
            stopStream();
            udp.mediaConnection.setSpeaking(false);
            udp.mediaConnection.setVideoAttributes(false);
        });
        
        let cleanedUp = false;
        const doCleanup = () => {
            if (cleanedUp) return;
            cleanedUp = true;
            for (const f of cleanupFuncs) f();
        };

        cancelSignal?.addEventListener("abort", () => {
            doCleanup();
            reject(cancelSignal.reason);
        }, { once: true });

        vStream.once("finish", () => {
            if (cancelSignal?.aborted) return;
            doCleanup();
            resolve();
        });
    });

    cleanup.catch(() => {});
    
    return controller;
}
