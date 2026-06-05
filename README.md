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

## Tuning

You can tune pose/freeze sensitivity with Vite env variables.

1. Copy `.env.example` to `.env`
2. Adjust values and restart dev server

- `VITE_POSE_MATCH_THRESHOLD_PERCENT` default `78`
- `VITE_HOLD_DURATION_MS` default `3000`
- `VITE_MOVEMENT_THRESHOLD` default `0.045`
- `VITE_MOVEMENT_SMOOTHING_ALPHA` default `0.2`
