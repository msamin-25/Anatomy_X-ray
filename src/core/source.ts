import { SRGBColorSpace, Texture, VideoTexture } from 'three';

export type Facing = 'user' | 'environment';

/** A stream of frames: the webcam, a video file, or a still image. */
export interface FrameSource {
  el: HTMLVideoElement | HTMLImageElement;
  /** Current frame size; a phone camera swaps these when the phone rotates. */
  readonly width: number;
  readonly height: number;
  texture: Texture;
  /** True for a selfie camera, which should be shown mirrored. */
  mirror: boolean;
  /** True for a camera, which fills the screen; files are shown whole. */
  live: boolean;
  /** The camera track, for zoom and light controls. */
  track?: MediaStreamTrack;
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
    get width() {
      return video.videoWidth;
    },
    get height() {
      return video.videoHeight;
    },
    texture,
    mirror,
    live: !!stream,
    track: stream?.getVideoTracks()[0],
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
      video.remove();
      texture.dispose();
    },
  };
}

function makeVideo(): HTMLVideoElement {
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true;
  video.loop = true;
  video.autoplay = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  // iOS Safari stops decoding a video that is not in the document, so keep it
  // there, invisible. (display: none would also stop it.)
  video.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.append(video);
  return video;
}

/**
 * Opens the front (`user`) or rear (`environment`) camera. `sharp` asks for
 * more pixels (for close-ups of skin); tracking runs faster at the default.
 */
export async function openCamera(facing: Facing = 'user', sharp = false): Promise<FrameSource> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser cannot open the camera here. Use HTTPS, or a current Safari or Chrome.');
  }
  // Ask for a frame shaped like the screen: a landscape request on a phone held
  // upright can come back cropped to a square.
  const portrait = window.innerHeight > window.innerWidth;
  const long = sharp ? 1920 : 1280;
  const short = sharp ? 1080 : 720;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: portrait ? short : long },
      height: { ideal: portrait ? long : short },
    },
  });
  const video = makeVideo();
  video.srcObject = stream;
  try {
    await video.play();
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    video.remove();
    throw err;
  }
  // Laptop webcams usually do not report a facing mode; treat them as selfie cameras.
  const reported = stream.getVideoTracks()[0]?.getSettings().facingMode;
  const mirror = reported ? reported === 'user' : facing === 'user';
  return videoSource(video, mirror, stream);
}

/** True when the device has more than one camera (call after camera permission is granted). */
export async function hasSeveralCameras(): Promise<boolean> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput').length > 1;
  } catch {
    return false;
  }
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
    live: false,
    // A still image is re-tracked every frame so the smoothing settles.
    hasNewFrame: () => true,
    dispose: () => texture.dispose(),
  };
}
