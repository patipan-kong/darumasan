# darumasan

AI vs Human - Daruma-san ga Koronda (Red Light Green Light)

Web demo built with Phaser 3 and MediaPipe Pose Landmarker.

## Features

- Webcam camera feed in game scene
- Pose tracking (33 keypoints)
- Real-time movement score from keypoint deltas
- GREEN LIGHT / RED LIGHT state machine
- Freeze validation (still for 3 seconds)
- Success and fail feedback with visual overlay

## Run locally

```bash
npm install
npm run dev
```

Then open the shown local URL (usually `http://localhost:5173`) and allow webcam access.
