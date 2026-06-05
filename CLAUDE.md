# CLAUDE.md

## Project
AI vs Human - Daruma-san ga Koronda (Red Light Green Light)
สร้าง Web Demo ด้วย Phaser 3 และ MediaPipe Pose Landmarker
ผู้เล่นยืนหน้ากล้อง Webcam และต้อง "หยุดนิ่ง" เมื่อ AI สั่งหยุด
---

## Goal
สร้าง Prototype ที่สามารถ:
1. เปิด Webcam
2. ตรวจจับ Pose ของผู้เล่นด้วย MediaPipe Pose Landmarker
3. ติดตามตำแหน่ง Keypoints ทั้ง 33 จุด
4. คำนวณการเคลื่อนไหวของร่างกายแบบ Real-time
5. ตรวจสอบว่าผู้เล่น "นิ่ง" ต่อเนื่อง 3 วินาทีหรือไม่
6. แสดงผลผ่าน Phaser 3 Game Scene
---

## Tech Stack

### Frontend
* TypeScript
* Vite
* Phaser 3

### AI / Vision
* MediaPipe Tasks Vision
* Pose Landmarker

### Runtime
* Browser
* Webcam API
* requestAnimationFrame

---

## Gameplay Rules
### GREEN LIGHT
ผู้เล่นสามารถขยับตัวได้
สถานะ:
```text
state = MOVING
```
ไม่มีการตรวจสอบความนิ่ง
---
### RED LIGHT
AI จะสั่งหยุด
สถานะ:
```text
state = FREEZE
```
เริ่มตรวจจับการเคลื่อนไหวของร่างกาย
---

## Pose Detection
ใช้ Pose Landmarker แบบ:
```ts
runningMode: "VIDEO"
numPoses: 1
```
อ่านค่าจุดทั้งหมด 33 จุด
ตัวอย่าง:
```ts
landmarks[0]
landmarks[11]
landmarks[12]
...
```
---

## Motion Detection Algorithm
ทุก Frame
เปรียบเทียบตำแหน่ง Keypoints ปัจจุบันกับ Frame ก่อนหน้า
คำนวณ:
```ts
delta =
sqrt(
(dx * dx) +
(dy * dy) +
(dz * dz)
)
```
สำหรับทุก Keypoint
---
## Total Body Movement Score
รวม Delta ของทุกจุด
```ts
bodyMovement =
sum(allKeypointDeltas)
```
---

## Noise Reduction
เพื่อป้องกัน Webcam Noise
ใช้:
```ts
movementThreshold = 0.015
```
ถ้า
```ts
bodyMovement < movementThreshold
```
ถือว่า "นิ่ง"
---

## Freeze Validation
เมื่อเข้าสู่ RED LIGHT
เริ่มจับเวลา
หาก
```ts
bodyMovement < threshold
```
ต่อเนื่องครบ
```text
3000 ms
```
ถือว่า PASS

---

## Fail Condition
หากระหว่าง RED LIGHT
```ts
bodyMovement >= threshold
```
ให้
```ts
freezeTimer = 0
```
และแสดง
```text
MOVE DETECTED!
```

---

## Success Condition
หากนิ่งครบ 3 วินาที
แสดง
```text
SUCCESS
```
พร้อมเสียงเอฟเฟกต์

---

## Game States
```ts
enum GameState {
  WAITING,
  GREEN_LIGHT,
  RED_LIGHT,
  SUCCESS,
  FAIL
}
```
---

## Architecture
```text
src/
main.ts
game/
  GameScene.ts
vision/
  PoseTracker.ts
systems/
  MotionDetector.ts
ui/
  StatusText.ts
assets/
```

---

## PoseTracker Responsibilities
* Initialize Pose Landmarker
* Start Webcam
* Read Pose Results
* Return Landmarks

API
```ts
getLandmarks(): NormalizedLandmark[]
```

---

## MotionDetector Responsibilities

Input:
```ts
landmarks
```

Output:
```ts
{
  movementScore: number,
  isStill: boolean
}
```

---

## Phaser Scene Responsibilities
* Render Camera Feed
* Render Pose Skeleton
* Render Status Text
* Manage State Machine
* Control Countdown Timer

---

## Visual Debug Overlay

Draw:
* Head
* Shoulders
* Elbows
* Wrists
* Hips
* Knees
* Ankles

Color:
Green = Stable
Red = Movement Detected

---

## UI
Top Center:
```text
AI DARUMA
```

Center:
```text
GREEN LIGHT
```

or
```text
FREEZE!
```

Bottom:
```text
Movement Score: 0.008
```

```text
Freeze Time: 2.4 / 3.0 sec
```

---

## Performance Requirements
Target:
```text
60 FPS
```

Pose Detection:
```text
20-30 FPS
```

Motion Detection:
```text
Every Frame
```

---

## Definition of Done

* Webcam works
* Pose detected
* 33 keypoints tracked
* Motion score calculated
* FREEZE state works
* 3-second stillness validation works
* Success / Fail states work
* Runs locally with:

npm install
npm run dev

without errors

```
```
