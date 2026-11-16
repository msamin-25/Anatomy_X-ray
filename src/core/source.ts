import { SRGBColorSpace, Texture, VideoTexture } from 'three';

/** A stream of frames: the webcam, a video file, or a still image. */
export interface FrameSource {
  el: HTMLVideoElement | HTMLImageElement;
  width: number;
  height: number;
  texture: Texture;
  /** True for a selfie camera, which should be shown mirrored. */
  mirror: boolean;
  /** Returns true when there is a frame the trackers have not seen yet. */
  hasNewFrame(): boolean;
  dispose(): void;
}

function videoSource(video: HTMLVideoElement, mirror: boolean, stream?: MediaStream): FrameSource {
  const texture = new VideoTexture(video);
  texture.colorSpace = SRGBColorSpace;
  let last = -1;
  return {
    el: video,
    width: video.videoWidth,
    height: video.videoHeight,
    texture,
    mirror,
    hasNewFrame() {
      if (video.readyState < 2 || video.currentTime === last) return false;
      last = video.currentTime;
      return true;
    },
    dispose() {
      stream?.getTracks().forEach((t) => t.stop());
      video.pause();
      video.removeAttribute('src');
      video.srcObject = null;
      texture.dispose();
    },
  };
}

function makeVideo(): HTMLVideoElement {
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.loop = true;
  return video;
}

export async function openCamera(): Promise<FrameSource> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
  });
  const video = makeVideo();
  video.srcObject = stream;
  await video.play();
  return videoSource(video, true, stream);
}

/** Opens an image or video from a URL (including object URLs from dropped files). */
export async function openMedia(url: string, isVideo: boolean): Promise<FrameSource> {
  if (isVideo) {
    const video = makeVideo();
    video.crossOrigin = 'anonymous';
    video.src = url;
    await video.play();
    return videoSource(video, false);
  }
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode();
  const texture = new Texture(img);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return {
    el: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    texture,
    mirror: false,
    // A still image is re-tracked every frame so the smoothing settles.
    hasNewFrame: () => true,
    dispose: () => texture.dispose(),
  };
}
