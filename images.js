const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB per image, after decoding

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/;

/**
 * Parses a `data:image/...;base64,...` string (exactly what
 * FileReader.readAsDataURL produces in the browser) into its mime type and
 * raw base64 payload, rejecting anything that isn't a reasonably-sized
 * image. Throws a plain Error with a user-facing message on anything odd.
 */
function parseImageDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') {
        throw new Error('Each image must be a base64 data URL string');
    }
    const match = DATA_URL_RE.exec(dataUrl);
    if (!match) {
        throw new Error('Image must be a PNG, JPEG, WEBP, or GIF data URL');
    }
    const [, mimeType, base64Data] = match;
    const approxBytes = (base64Data.length * 3) / 4;
    if (approxBytes > MAX_IMAGE_BYTES) {
        throw new Error('Each image must be under 4MB');
    }
    return { mimeType, data: base64Data };
}

module.exports = { parseImageDataUrl, MAX_IMAGE_BYTES };
