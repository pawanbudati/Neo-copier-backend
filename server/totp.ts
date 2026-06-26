import crypto from "crypto";

/**
 * Generates a standard 6-digit TOTP token using the provided Base32 secret key.
 * This is compatible with Google Authenticator and Kotak Neo's 2FA.
 */
export function generateTOTP(secret: string): string {
  // Clean secret: remove spaces and translate to uppercase
  const cleanSecret = secret.replace(/\s+/g, "").toUpperCase();

  // Base32 lookup table
  const base32chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (let i = 0; i < cleanSecret.length; i++) {
    const val = base32chars.indexOf(cleanSecret.charAt(i));
    if (val === -1) {
      continue; // Skip invalid base32 characters
    }
    bits += val.toString(2).padStart(5, "0");
  }

  // Convert bits to buffer
  const bufferLen = Math.floor(bits.length / 8);
  if (bufferLen === 0) {
    return "000000";
  }
  const buffer = Buffer.alloc(bufferLen);
  for (let i = 0; i < buffer.length; i++) {
    buffer[i] = parseInt(bits.slice(i * 8, (i + 1) * 8), 2);
  }

  // Get current 30-second window epoch
  const epoch = Math.round(Date.now() / 1000);
  const timeWindow = Math.floor(epoch / 30);

  // Put timeWindow into 8-byte buffer (big endian)
  const timeBuffer = Buffer.alloc(8);
  let temp = timeWindow;
  for (let i = 7; i >= 0; i--) {
    timeBuffer[i] = temp & 0xff;
    temp = Math.floor(temp / 256);
  }

  // Generate HMAC-SHA1
  const hmac = crypto.createHmac("sha1", buffer);
  hmac.update(timeBuffer);
  const hmacResult = hmac.digest();

  // Dynamic truncation of the HMAC result
  const offset = hmacResult[hmacResult.length - 1] & 0x0f;
  const binary =
    ((hmacResult[offset] & 0x7f) << 24) |
    ((hmacResult[offset + 1] & 0xff) << 16) |
    ((hmacResult[offset + 2] & 0xff) << 8) |
    (hmacResult[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, "0");
}
