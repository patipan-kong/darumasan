import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { Landmark } from "../systems/MotionDetector";

export class PoseTracker {
  private videoElement: HTMLVideoElement | null = null;
  private poseLandmarker: PoseLandmarker | null = null;
  private lastLandmarks: Landmark[] = [];

  public async init(): Promise<void> {
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 960 },
        height: { ideal: 540 },
        facingMode: "user"
      },
      audio: false
    });

    this.videoElement = document.createElement("video");
    this.videoElement.autoplay = true;
    this.videoElement.muted = true;
    this.videoElement.playsInline = true;
    this.videoElement.srcObject = mediaStream;

    await this.videoElement.play();

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
    );

    this.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"
      },
      runningMode: "VIDEO",
      numPoses: 1
    });
  }

  public detect(timestampMs: number): Landmark[] {
    if (!this.poseLandmarker || !this.videoElement || this.videoElement.readyState < 2) {
      return this.lastLandmarks;
    }

    const result = this.poseLandmarker.detectForVideo(this.videoElement, timestampMs);
    const detected = result.landmarks[0] ?? [];

    this.lastLandmarks = detected.map((point) => ({
      x: point.x,
      y: point.y,
      z: point.z
    }));

    return this.lastLandmarks;
  }

  public getLandmarks(): Landmark[] {
    return this.lastLandmarks;
  }

  public getVideoElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  public dispose(): void {
    if (this.videoElement?.srcObject) {
      const stream = this.videoElement.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
    }

    this.poseLandmarker?.close();
    this.lastLandmarks = [];
    this.videoElement = null;
    this.poseLandmarker = null;
  }
}
