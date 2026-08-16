import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { supabase } from '../config/supabase.js';

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// 1. Citizen Email/Password Signup
export const citizenSignup = async (req, res, next) => {
  try {
    const { email, password, full_name } = req.body;

    if (!email || !password || !full_name) {
      return res.status(400).json({ error: 'Email, password, and full name are required.' });
    }

    // Check if user already exists
    const { data: existingUser } = await supabase
      .from('citizens')
      .select('id')
      .eq('email', email)
      .single();

    if (existingUser) {
      return res.status(400).json({ error: 'Citizen account already exists with this email.' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Insert Citizen into 'citizens' table
    const { data: newCitizen, error } = await supabase
      .from('citizens')
      .insert([{ email, password_hash, full_name }])
      .select('id, email, full_name, created_at')
      .single();

    if (error) throw error;

    // Generate JWT
    const token = jwt.sign(
      { id: newCitizen.id, email: newCitizen.email, userType: 'citizen' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Citizen registered successfully',
      user: newCitizen,
      token
    });
  } catch (err) {
    next(err);
  }
};

// 2. Citizen Email/Password Login
export const citizenLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // Fetch citizen
    const { data: citizen, error } = await supabase
      .from('citizens')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !citizen) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Check password
    if (!citizen.password_hash) {
      return res.status(400).json({ error: 'Account created with Google. Please sign in with Google.' });
    }

    const isMatch = await bcrypt.compare(password, citizen.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Generate JWT
    const token = jwt.sign(
      { id: citizen.id, email: citizen.email, userType: 'citizen' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      message: 'Citizen login successful',
      user: { id: citizen.id, email: citizen.email, full_name: citizen.full_name },
      token
    });
  } catch (err) {
    next(err);
  }
};

// 3. Citizen Google OAuth Sign-In / Sign-Up
export const citizenGoogleAuth = async (req, res, next) => {
  try {
    const { idToken } = req.body; // Received from frontend React Google Login

    if (!idToken) {
      return res.status(400).json({ error: 'Google ID Token is required.' });
    }

    // Verify token with Google
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { sub: google_id, email, name: full_name } = payload;

    // Check if citizen exists by google_id or email
    let { data: citizen } = await supabase
      .from('citizens')
      .select('*')
      .or(`google_id.eq.${google_id},email.eq.${email}`)
      .maybeSingle();

    if (!citizen) {
      // Sign up new Google Citizen
      const { data: newCitizen, error: insertError } = await supabase
        .from('citizens')
        .insert([{ email, full_name, google_id }])
        .select('*')
        .single();

      if (insertError) throw insertError;
      citizen = newCitizen;
    } else if (!citizen.google_id) {
      // Link Google ID if registered via email previously
      await supabase
        .from('citizens')
        .update({ google_id })
        .eq('id', citizen.id);
    }

    // Generate JWT
    const token = jwt.sign(
      { id: citizen.id, email: citizen.email, userType: 'citizen' },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      message: 'Google authentication successful',
      user: { id: citizen.id, email: citizen.email, full_name: citizen.full_name },
      token
    });
  } catch (err) {
    next(err);
  }
};