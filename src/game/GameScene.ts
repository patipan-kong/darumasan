import Phaser from "phaser";
import { MotionDetector } from "../systems/MotionDetector";
import type { Landmark } from "../systems/MotionDetector";
import { StatusText } from "../ui/StatusText";
import { PoseTracker } from "../vision/PoseTracker";

enum GameState {
  WAITING,
  GREEN_LIGHT,
  RED_LIGHT,
  SUCCESS,
  FAIL
}

const SKELETON_CONNECTIONS: Array<[number, number]> = [
  [0, 11],
  [0, 12],
  [11, 12],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [24, 26],
  [26, 28]
];

const DEBUG_KEYPOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

export class GameScene extends Phaser.Scene {
  private poseTracker: PoseTracker;
  private motionDetector: MotionDetector;
  private statusText: StatusText | null = null;
  private state: GameState = GameState.WAITING;
  private webcamTexture: Phaser.Textures.CanvasTexture | null = null;
  private webcamImage: Phaser.GameObjects.Image | null = null;
  private overlayGraphics: Phaser.GameObjects.Graphics | null = null;
  private freezeTimerMs = 0;
  private lastMovementScore = 0;
  private redLightDurationMs = 3000;
  private greenLightDurationMs = 0;
  private lastPoseUpdateMs = 0;
  private stateChangedAtMs = 0;

  constructor() {
    super("GameScene");
    this.poseTracker = new PoseTracker();
    this.motionDetector = new MotionDetector(0.05);
  }

  public async create(): Promise<void> {
    const { width, height } = this.scale;
    this.statusText = new StatusText(this, width, height);
    this.overlayGraphics = this.add.graphics().setDepth(10);

    this.webcamTexture = this.textures.createCanvas("webcam-feed", width, height);
    this.webcamImage = this.add
      .image(width / 2, height / 2, "webcam-feed")
      .setDisplaySize(width, height)
      .setDepth(1);

    try {
      await this.poseTracker.init();
      this.enterGreenLight(this.time.now);
    } catch (error) {
      this.state = GameState.FAIL;
      this.statusText.setCenterMessage("WEBCAM / MODEL ERROR", "#ff5c5c");
      this.statusText.setMovementScore(0);
      this.statusText.setFreezeTime(0);
      console.error(error);
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.poseTracker.dispose();
    });
  }

  public update(time: number, delta: number): void {
    if (!this.statusText || !this.webcamTexture || !this.overlayGraphics) {
      return;
    }

    this.drawWebcamFrame();

    let landmarks = this.poseTracker.getLandmarks();
    if (time - this.lastPoseUpdateMs >= 33) {
      landmarks = this.poseTracker.detect(time);
      this.lastPoseUpdateMs = time;
    }

    let isStill = true;
    if (landmarks.length > 0) {
      const motion = this.motionDetector.analyze(landmarks);
      this.lastMovementScore = motion.movementScore;
      isStill = motion.isStill;
    } else {
      this.lastMovementScore = 0;
      this.motionDetector.reset();
    }

    this.statusText.setMovementScore(this.lastMovementScore);
    this.drawDebugSkeleton(landmarks, isStill);
    this.advanceStateMachine(time, delta, landmarks.length > 0, isStill);
  }

  private advanceStateMachine(time: number, delta: number, hasPose: boolean, isStill: boolean): void {
    if (!this.statusText) {
      return;
    }

    if (!hasPose && this.state !== GameState.WAITING) {
      this.statusText.setCenterMessage("NO POSE DETECTED", "#ffd966");
      this.freezeTimerMs = 0;
      this.statusText.setFreezeTime(0);
      return;
    }

    switch (this.state) {
      case GameState.WAITING:
        this.statusText.setCenterMessage("WAITING FOR POSE", "#f0f2f5");
        this.statusText.setFreezeTime(0);
        break;
      case GameState.GREEN_LIGHT: {
        this.statusText.setCenterMessage("GREEN LIGHT", "#4dff9d");
        this.statusText.setFreezeTime(0);
        if (time - this.stateChangedAtMs >= this.greenLightDurationMs) {
          this.enterRedLight(time);
        }
        break;
      }
      case GameState.RED_LIGHT:
        this.statusText.setCenterMessage("FREEZE!", "#ff6b6b");
        if (isStill) {
          this.freezeTimerMs += delta;
        } else {
          this.freezeTimerMs = 0;
          this.enterFail(time);
        }
        this.statusText.setFreezeTime(this.freezeTimerMs / 1000);
        if (this.freezeTimerMs >= this.redLightDurationMs) {
          this.enterSuccess(time);
        }
        break;
      case GameState.SUCCESS:
        this.statusText.setCenterMessage("SUCCESS", "#7dff75");
        this.statusText.setFreezeTime(this.redLightDurationMs / 1000);
        if (time - this.stateChangedAtMs > 1600) {
          this.enterGreenLight(time);
        }
        break;
      case GameState.FAIL:
        this.statusText.setCenterMessage("MOVE DETECTED!", "#ff5f5f");
        this.statusText.setFreezeTime(0);
        if (time - this.stateChangedAtMs > 1200) {
          this.enterGreenLight(time);
        }
        break;
      default:
        break;
    }
  }

  private enterGreenLight(time: number): void {
    this.state = GameState.GREEN_LIGHT;
    this.stateChangedAtMs = time;
    this.greenLightDurationMs = this.randomGreenDuration();
    this.freezeTimerMs = 0;
    this.motionDetector.reset();
  }

  private enterRedLight(time: number): void {
    this.state = GameState.RED_LIGHT;
    this.stateChangedAtMs = time;
    this.freezeTimerMs = 0;
    this.motionDetector.reset();
  }

  private enterSuccess(time: number): void {
    this.state = GameState.SUCCESS;
    this.stateChangedAtMs = time;
    this.playSuccessBeep();
  }

  private enterFail(time: number): void {
    this.state = GameState.FAIL;
    this.stateChangedAtMs = time;
  }

  private randomGreenDuration(): number {
    return 1800 + Math.floor(Math.random() * 1800);
  }

  private drawWebcamFrame(): void {
    if (!this.webcamTexture) {
      return;
    }

    const video = this.poseTracker.getVideoElement();
    if (!video || video.readyState < 2) {
      return;
    }

    const context = this.webcamTexture.getContext();
    const width = this.webcamTexture.width;
    const height = this.webcamTexture.height;

    context.save();
    context.clearRect(0, 0, width, height);
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, width, height);
    context.restore();

    this.webcamTexture.refresh();
  }

  private drawDebugSkeleton(landmarks: Landmark[], isStill: boolean): void {
    if (!this.overlayGraphics) {
      return;
    }

    this.overlayGraphics.clear();
    if (landmarks.length === 0) {
      return;
    }

    const color = isStill ? 0x3cff8e : 0xff4d4d;
    const width = this.scale.width;
    const height = this.scale.height;

    this.overlayGraphics.lineStyle(3, color, 0.9);
    for (const [a, b] of SKELETON_CONNECTIONS) {
      if (!landmarks[a] || !landmarks[b]) {
        continue;
      }

      const ax = (1 - landmarks[a].x) * width;
      const ay = landmarks[a].y * height;
      const bx = (1 - landmarks[b].x) * width;
      const by = landmarks[b].y * height;
      this.overlayGraphics.lineBetween(ax, ay, bx, by);
    }

    this.overlayGraphics.fillStyle(color, 1);
    for (const index of DEBUG_KEYPOINTS) {
      if (!landmarks[index]) {
        continue;
      }

      const x = (1 - landmarks[index].x) * width;
      const y = landmarks[index].y * height;
      this.overlayGraphics.fillCircle(x, y, 6);
    }
  }

  private playSuccessBeep(): void {
    const AudioCtx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) {
      return;
    }

    const context = new AudioCtx();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.setValueAtTime(740, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1040, context.currentTime + 0.2);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);

    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.36);
  }
}
