export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface MotionResult {
  movementScore: number;
  isStill: boolean;
}

export class MotionDetector {
  private readonly movementThreshold: number;
  private previousLandmarks: Landmark[] | null = null;

  constructor(movementThreshold = 0.015) {
    this.movementThreshold = movementThreshold;
  }

  public analyze(landmarks: Landmark[]): MotionResult {
    if (!this.previousLandmarks || this.previousLandmarks.length !== landmarks.length) {
      this.previousLandmarks = landmarks.map((point) => ({ ...point }));
      return { movementScore: 0, isStill: true };
    }

    let movementScore = 0;
    for (let i = 0; i < landmarks.length; i += 1) {
      const prev = this.previousLandmarks[i];
      const curr = landmarks[i];
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const dz = curr.z - prev.z;
      movementScore += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    this.previousLandmarks = landmarks.map((point) => ({ ...point }));
    return {
      movementScore,
      isStill: movementScore < this.movementThreshold
    };
  }

  public reset(): void {
    this.previousLandmarks = null;
  }
}
