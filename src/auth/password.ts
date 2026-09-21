import crypto from "crypto";

// OWASP-recommended floor for PBKDF2-HMAC-SHA512 (~210k for SHA256; SHA512's
// larger block size means ~120k gives comparable work factor — we go higher
// to be safe). The previous constant (1000) was ~100x too cheap, making an
// offline brute-force of a leaked passwordHash/salt pair impractically fast.
// Iteration count is stored in the hash itself ("iterations$hex") so old
// hashes minted at 1000 iterations keep verifying correctly after this bump
// — there is no migration step, existing users just re-hash at login... but
// since we don't rehash on login here, legacy hashes stay at 1000 iterations
// until the user resets their password. That's an acceptable trade-off vs.
// invalidating every existing password.
const PBKDF2_ITERATIONS = 210000;
const LEGACY_PBKDF2_ITERATIONS = 1000;

export function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString("hex");
  const hex = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 64, "sha512").toString("hex");
  return { hash: `${PBKDF2_ITERATIONS}$${hex}`, salt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const sepIndex = hash.indexOf("$");
  const iterations = sepIndex === -1 ? LEGACY_PBKDF2_ITERATIONS : parseInt(hash.slice(0, sepIndex), 10);
  const storedHex = sepIndex === -1 ? hash : hash.slice(sepIndex + 1);

  // A corrupted/malformed stored hash must fail auth like a wrong password,
  // not crash pbkdf2Sync with a RangeError on a non-numeric iteration count.
  if (!Number.isInteger(iterations) || iterations <= 0) return false;

  const verifyHash = crypto.pbkdf2Sync(password, salt, iterations, 64, "sha512");
  const storedHash = Buffer.from(storedHex, "hex");
  return verifyHash.length === storedHash.length && crypto.timingSafeEqual(verifyHash, storedHash);
}
