import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { supabase } from '../config/supabase.js';

// 1. Admin Email/Password Login
export const adminLogin = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    // Use .maybeSingle() to safely handle non-existent admin emails
    const { data: admin, error } = await supabase
      .from('admins')
      .select('*')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle();

    if (error || !admin) {
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    // Verify hashed password
    const isMatch = await bcrypt.compare(password, admin.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid admin credentials.' });
    }

    // Generate Admin JWT Token
    const token = jwt.sign(
      { id: admin.id, email: admin.email, role: admin.role, userType: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.status(200).json({
      message: 'Admin authentication successful',
      user: {
        id: admin.id,
        email: admin.email,
        full_name: admin.full_name,
        role: admin.role,
      },
      token,
    });
  } catch (err) {
    next(err);
  }
};

// 2. Admin Signup / Registration
export const adminSignup = async (req, res, next) => {
  try {
    const { full_name, email, password, role } = req.body;

    if (!full_name || !email || !password) {
      return res.status(400).json({ error: 'Full name, email, and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if admin already exists
    const { data: existingAdmin } = await supabase
      .from('admins')
      .select('id')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingAdmin) {
      return res.status(400).json({ error: 'An admin account with this email already exists.' });
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, 10);

    // Insert new admin record
    const { data: newAdmin, error } = await supabase
      .from('admins')
      .insert([
        {
          full_name,
          email: normalizedEmail,
          password_hash,
          role: role || 'Admin',
        },
      ])
      .select('id, full_name, email, role, created_at')
      .single();

    if (error) throw error;

    // Generate Admin JWT Token
    const token = jwt.sign(
      { id: newAdmin.id, email: newAdmin.email, role: newAdmin.role, userType: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    res.status(201).json({
      message: 'Admin account created successfully',
      user: newAdmin,
      token,
    });
  } catch (err) {
    next(err);
  }
};