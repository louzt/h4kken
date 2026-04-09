// ============================================================
// H4KKEN - Fighting Game Camera (Babylon.js)
// ============================================================

import { type FreeCamera, Scalar, Vector3 } from '@babylonjs/core';

export class FightCamera {
  camera: FreeCamera;
  targetPosition: Vector3;
  targetLookAt: Vector3;
  currentLookAt: Vector3;
  smoothSpeed: number;
  minDistance: number;
  maxDistance: number;
  heightOffset: number;
  lookAtHeightOffset: number;
  shakeIntensity: number;
  shakeDuration: number;
  shakeTimer: number;
  orbitAngle: number;

  constructor(camera: FreeCamera) {
    this.camera = camera;
    // Babylon left-handed: Z away from camera, so initial position has negative Z
    this.targetPosition = new Vector3(0, 3, -10);
    this.targetLookAt = new Vector3(0, 1.2, 0);
    this.currentLookAt = new Vector3(0, 1.2, 0);
    this.smoothSpeed = 0.06;
    this.minDistance = 5;
    this.maxDistance = 11;
    this.heightOffset = 2.5;
    this.lookAtHeightOffset = 1.2;
    this.shakeIntensity = 0;
    this.shakeDuration = 0;
    this.shakeTimer = 0;
    // Orbit angle starts at -PI/2 so camera is behind fighters (negative Z side)
    this.orbitAngle = -Math.PI / 2;

    this.camera.position.copyFrom(this.targetPosition);
    this.camera.setTarget(this.targetLookAt);
  }

  update(fighter1Pos: Vector3, fighter2Pos: Vector3, deltaTime: number, localPlayerIndex = 0) {
    const midX = (fighter1Pos.x + fighter2Pos.x) / 2;
    const midY = Math.max((fighter1Pos.y + fighter2Pos.y) / 2, 0);
    const midZ = (fighter1Pos.z + fighter2Pos.z) / 2;

    const localPos = localPlayerIndex === 0 ? fighter1Pos : fighter2Pos;
    const remotePos = localPlayerIndex === 0 ? fighter2Pos : fighter1Pos;
    const dx = remotePos.x - localPos.x;
    const dz = remotePos.z - localPos.z;
    const fighterDist = Math.sqrt(dx * dx + dz * dz);

    if (fighterDist > 0.1) {
      const fightAngle = Math.atan2(dz, dx);
      // Camera orbits perpendicular to the fight axis. Subtract PI/2 so the camera
      // stays on the -Z side (initial orbitAngle), keeping local player on screen LEFT.
      const targetOrbit = fightAngle - Math.PI / 2;

      let angleDiff = targetOrbit - this.orbitAngle;
      while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
      while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
      this.orbitAngle += angleDiff * 0.06;
    }

    const zoomFactor = Scalar.Clamp(fighterDist / 8, 0, 1);
    const depth = Scalar.Lerp(this.minDistance, this.maxDistance, zoomFactor);
    const height = this.heightOffset + zoomFactor * 1.5;

    this.targetPosition.set(
      midX + Math.cos(this.orbitAngle) * depth,
      midY + height,
      midZ + Math.sin(this.orbitAngle) * depth,
    );

    this.targetLookAt.set(midX, midY + this.lookAtHeightOffset, midZ);

    Vector3.LerpToRef(
      this.camera.position,
      this.targetPosition,
      this.smoothSpeed,
      this.camera.position,
    );
    Vector3.LerpToRef(this.currentLookAt, this.targetLookAt, this.smoothSpeed, this.currentLookAt);

    if (this.shakeTimer > 0) {
      this.shakeTimer -= deltaTime;
      const shakePower = this.shakeIntensity * (this.shakeTimer / this.shakeDuration);
      this.camera.position.x += (Math.random() - 0.5) * shakePower;
      this.camera.position.y += (Math.random() - 0.5) * shakePower * 0.5;
    }

    this.camera.setTarget(this.currentLookAt);
  }

  shake(intensity: number, duration: number) {
    this.shakeIntensity = intensity;
    this.shakeDuration = duration;
    this.shakeTimer = duration;
  }

  setDramaticAngle(focusPos: Vector3) {
    const cosA = Math.cos(this.orbitAngle);
    const sinA = Math.sin(this.orbitAngle);
    this.targetPosition.set(focusPos.x + cosA * 4, focusPos.y + 2, focusPos.z + sinA * 4);
    this.targetLookAt.set(focusPos.x, focusPos.y + 1.2, focusPos.z);
    this.smoothSpeed = 0.03;
  }

  reset() {
    this.smoothSpeed = 0.06;
  }
}
