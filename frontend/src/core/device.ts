const quality = new URLSearchParams(location.search).get('quality');

/**
 * Phones and tablets get a lighter setup: a lower render resolution and the
 * lighter body tracker. `?quality=lite` or `?quality=full` overrides the
 * detection, for testing.
 */
export const LITE = quality === 'lite' || (quality !== 'full' && matchMedia('(pointer: coarse)').matches);
