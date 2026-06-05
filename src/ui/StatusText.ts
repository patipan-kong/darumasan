import Phaser from "phaser";

export class StatusText {
  private readonly titleText: Phaser.GameObjects.Text;
  private readonly centerText: Phaser.GameObjects.Text;
  private readonly matchText: Phaser.GameObjects.Text;
  private readonly holdTimerText: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, width: number, height: number) {
    this.titleText = scene.add
      .text(width / 2, 24, "AI DARUMA", {
        fontFamily: "Trebuchet MS",
        fontSize: "40px",
        color: "#f7d047",
        stroke: "#1f1600",
        strokeThickness: 5,
      })
      .setOrigin(0.5, 0)
      .setDepth(20);

    this.centerText = scene.add
      .text(width / 2, height / 2, "WAITING FOR WEBCAM", {
        fontFamily: "Trebuchet MS",
        fontSize: "54px",
        color: "#ffffff",
        stroke: "#101010",
        strokeThickness: 6,
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(20);

    this.matchText = scene.add
      .text(width / 2, height - 62, "Match: 0%", {
        fontFamily: "Consolas",
        fontSize: "28px",
        color: "#b7d7ff",
        stroke: "#101010",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(20);

    this.holdTimerText = scene.add
      .text(width / 2, height - 28, "Hold: 0.0 / 3.0 sec", {
        fontFamily: "Consolas",
        fontSize: "24px",
        color: "#d6ebff",
        stroke: "#101010",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(20);
  }

  public setCenterMessage(message: string, color = "#ffffff"): void {
    this.centerText.setText(message);
    this.centerText.setColor(color);
  }

  public setMatchScore(score: number): void {
    this.matchText.setText(`Match: ${Math.round(score * 100)}%`);
  }

  public setHoldTime(seconds: number, totalSec = 3): void {
    this.holdTimerText.setText(`Hold: ${seconds.toFixed(1)} / ${totalSec.toFixed(1)} sec`);
  }
}
