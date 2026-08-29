import { supabaseAdmin } from '../config/supabase.js';

// GET /api/admin/citizens - Get all citizens with their stats
export const getAllCitizens = async (req, res, next) => {
  try {
    // Fetch all citizen profiles
    const { data: citizens, error: citizensError } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, phone, address, avatar_url, is_active, created_at')
      .eq('role', 'citizen')
      .order('created_at', { ascending: false });

    if (citizensError) throw citizensError;

    // Enrich each citizen with their stats
    const citizensWithStats = await Promise.all(
      citizens.map(async (citizen) => {
        // Get complaint count
        const { count: complaintsCount } = await supabaseAdmin
          .from('complaints')
          .select('id', { count: 'exact', head: true })
          .eq('citizen_id', citizen.id);

        // Get resolved complaints count
        const { data: citizenComplaints = [] } = await supabaseAdmin
          .from('complaints')
          .select('status')
          .eq('citizen_id', citizen.id);

        const resolvedCount = (citizenComplaints || []).filter((complaint) => {
          const status = String(complaint.status || '').trim().toLowerCase();
          return ['resolved', 'solved', 'closed', 'completed', 'cleaned', 'fixed', 'done'].includes(status);
        }).length;

        // Get carbon card
        const { data: carbonCard } = await supabaseAdmin
          .from('carbon_cards')
          .select('total_points, available_points, tier')
          .eq('citizen_id', citizen.id)
          .maybeSingle();

        return {
          ...citizen,
          stats: {
            total_complaints: complaintsCount || 0,
            resolved_complaints: resolvedCount || 0,
            pending_complaints: (complaintsCount || 0) - (resolvedCount || 0),
          },
          carbon_card: carbonCard || { total_points: 0, available_points: 0, tier: 'Bronze' },
        };
      })
    );

    res.status(200).json({
      count: citizensWithStats.length,
      citizens: citizensWithStats,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/citizens/:id - Get single citizen profile with full details
export const getCitizenById = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Fetch citizen profile
    const { data: citizen, error: citizenError } = await supabaseAdmin
      .from('profiles')
      .select('id, email, full_name, phone, address, avatar_url, is_active, created_at, updated_at')
      .eq('id', id)
      .eq('role', 'citizen')
      .single();

    if (citizenError || !citizen) {
      return res.status(404).json({ error: 'Citizen not found.' });
    }

    // Get complaints
    const { data: complaints } = await supabaseAdmin
      .from('complaints')
      .select('id, description, category, status, priority, latitude, longitude, image_url, created_at')
      .eq('citizen_id', id)
      .order('created_at', { ascending: false });

    // Get carbon card
    const { data: carbonCard } = await supabaseAdmin
      .from('carbon_cards')
      .select('*')
      .eq('citizen_id', id)
      .maybeSingle();

    // Get report count
    const { count: reportsCount } = await supabaseAdmin
      .from('citizen_reports')
      .select('id', { count: 'exact', head: true })
      .eq('citizen_id', id);

    res.status(200).json({
      citizen: {
        ...citizen,
        complaints: complaints || [],
        carbon_card: carbonCard || { total_points: 0, available_points: 0, tier: 'Bronze' },
        stats: {
          total_complaints: complaints?.length || 0,
          resolved_complaints: complaints?.filter(c => ['resolved', 'solved', 'closed', 'completed', 'cleaned', 'fixed', 'done'].includes(String(c.status || '').trim().toLowerCase())).length || 0,
          pending_complaints: complaints?.filter(c => !['resolved', 'solved', 'closed', 'completed', 'cleaned', 'fixed', 'done'].includes(String(c.status || '').trim().toLowerCase())).length || 0,
          total_reports: reportsCount || 0,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/admin/citizens/:id/toggle-status - Activate/deactivate citizen
export const toggleCitizenStatus = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Get current status
    const { data: profile, error: fetchError } = await supabaseAdmin
      .from('profiles')
      .select('is_active, role')
      .eq('id', id)
      .single();

    if (fetchError || !profile) {
      return res.status(404).json({ error: 'Citizen not found.' });
    }

    if (profile.role !== 'citizen') {
      return res.status(400).json({ error: 'User is not a citizen.' });
    }

    // Toggle status
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('profiles')
      .update({ is_active: !profile.is_active })
      .eq('id', id)
      .select()
      .single();

    if (updateError) throw updateError;

    res.status(200).json({
      message: `Citizen account ${updated.is_active ? 'activated' : 'deactivated'} successfully.`,
      citizen: updated,
    });
  } catch (err) {
    next(err);
  }
};

// GET /api/admin/stats - Get dashboard statistics
export const getAdminStats = async (req, res, next) => {
  try {
    // Count citizens
    const { count: citizensCount } = await supabaseAdmin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'citizen');

    // Count active citizens
    const { count: activeCitizensCount } = await supabaseAdmin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'citizen')
      .eq('is_active', true);

    // Count total complaints
    const { count: complaintsCount } = await supabaseAdmin
      .from('complaints')
      .select('id', { count: 'exact', head: true });

    const { data: allComplaints = [] } = await supabaseAdmin
      .from('complaints')
      .select('status');

    const resolvedCount = (allComplaints || []).filter((complaint) => {
      const status = String(complaint.status || '').trim().toLowerCase();
      return ['resolved', 'solved', 'closed', 'completed', 'cleaned', 'fixed', 'done'].includes(status);
    }).length;

    // Count bins
    const { count: binsCount } = await supabaseAdmin
      .from('bins')
      .select('id', { count: 'exact', head: true });

    // Count vehicles
    const { count: vehiclesCount } = await supabaseAdmin
      .from('vehicles')
      .select('id', { count: 'exact', head: true });

    res.status(200).json({
      stats: {
        total_citizens: citizensCount || 0,
        active_citizens: activeCitizensCount || 0,
        total_complaints: complaintsCount || 0,
        resolved_complaints: resolvedCount || 0,
        pending_complaints: (complaintsCount || 0) - (resolvedCount || 0),
        total_bins: binsCount || 0,
        total_vehicles: vehiclesCount || 0,
      },
    });
  } catch (err) {
    next(err);
  }
};
