// OTP is now handled natively by Supabase Auth (signInWithOtp).
// This file is kept for compatibility — sendOtp and verifyOtp
// are no longer called since auth controllers use Supabase Auth directly.
// Safe to ignore or remove imports of this file.

export const sendOtp = async () => {
  throw new Error('sendOtp is deprecated. Use supabase.auth.signInWithOtp() directly.');
};

export const verifyOtp = async () => {
  throw new Error('verifyOtp is deprecated. Use supabase.auth.verifyOtp() directly.');
};
