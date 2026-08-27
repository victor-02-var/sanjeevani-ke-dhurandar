import { supabaseAdmin as supabase } from '../config/supabase.js';

// GET /api/tracking/assigned-drivers - Fetch assigned drivers and active live telemetry
export const getAssignedDriversTracking = async (req, res, next) => {
  try {
    const { complaintId } = req.query;

    // 1. Fetch active complaints with assigned drivers
    let query = supabase
      .from('complaints')
      .select('id, category, latitude, longitude, status, priority, assigned_driver_id')
      .not('assigned_driver_id', 'is', null)
      .not('assigned_driver_id', 'eq', '')
      .neq('status', 'Resolved');

    if (complaintId) {
      query = query.eq('id', complaintId);
    }

    const { data: complaints, error: compError } = await query;

    if (compError) throw compError;

    // Extract unique assigned driver UUIDs
    const assignedDriverIds = [...new Set((complaints || []).map((c) => c.assigned_driver_id).filter(Boolean))];

    // 2. Fetch vehicles from database with explicit coordinate columns
    let vehicleQuery = supabase
      .from('vehicles')
      .select('id, driver_name, license_plate, status, speed, capacity_kg, current_load_kg, latitude, longitude');

    if (complaintId && assignedDriverIds.length > 0) {
      const idFilters = assignedDriverIds.map((id) => `id.eq.${id}`).join(',');
      vehicleQuery = vehicleQuery.or(idFilters);
    } else if (complaintId && assignedDriverIds.length === 0) {
      return res.status(200).json({
        success: true,
        vehicles: [],
        assignedComplaints: complaints || []
      });
    }

    const { data: vehicles, error } = await vehicleQuery;

    if (error) throw error;

    // Normalize coordinates with safety fallbacks to Nashik center
    const normalizedVehicles = (vehicles || []).map((v) => ({
      ...v,
      latitude: v.latitude !== null && v.latitude !== undefined ? parseFloat(v.latitude) : 19.9975,
      longitude: v.longitude !== null && v.longitude !== undefined ? parseFloat(v.longitude) : 73.7898
    }));

    res.status(200).json({
      success: true,
      vehicles: normalizedVehicles,
      assignedComplaints: complaints || []
    });
  } catch (err) {
    next(err);
  }
};