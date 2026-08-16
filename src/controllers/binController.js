import { supabase } from '../config/supabase.js';
import { calculateBinMetrics } from '../utils/priorityEngine.js';
import { generateMockBins } from '../utils/mockBinGenerator.js';

// 1. GET /api/bins - Retrieve all bins with optional status/ward filter
export const getAllBins = async (req, res, next) => {
  try {
    const { status, ward } = req.query;

    let query = supabase
      .from('bins')
      .select('*')
      .order('priority_score', { ascending: false });

    if (status && status !== 'all') {
      query = query.ilike('status', status);
    }
    if (ward && ward !== 'All Wards') {
      query = query.ilike('ward', `%${ward}%`);
    }

    const { data: bins, error } = await query;
    if (error) throw error;

    res.status(200).json({
      count: bins.length,
      bins,
    });
  } catch (err) {
    next(err);
  }
};

// 2. GET /api/bins/:id - Get single bin details
export const getBinById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: bin, error } = await supabase
      .from('bins')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !bin) {
      return res.status(404).json({ error: 'Bin not found' });
    }

    res.status(200).json({ bin });
  } catch (err) {
    next(err);
  }
};

// 3. POST /api/bins - Manually create a new bin
export const createBin = async (req, res, next) => {
  try {
    const { latitude, longitude, fill_level = 0, ward, zone } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'Latitude and Longitude are required.' });
    }

    const last_collected = new Date().toISOString();
    const { status, priorityScore } = calculateBinMetrics(fill_level, last_collected);

    const { data: newBin, error } = await supabase
      .from('bins')
      .insert([
        {
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          fill_level: parseInt(fill_level, 10),
          ward: ward || 'Shivajinagar',
          zone: zone || 'Zone A',
          status,
          priority_score: priorityScore,
          last_collected,
        },
      ])
      .select()
      .single();

    if (error) throw error;

    res.status(201).json({ message: 'Bin created successfully', bin: newBin });
  } catch (err) {
    next(err);
  }
};

// 4. PUT /api/bins/:id - Update an existing bin
export const updateBin = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { latitude, longitude, fill_level, ward, zone } = req.body;

    const updates = {};
    if (latitude !== undefined) updates.latitude = parseFloat(latitude);
    if (longitude !== undefined) updates.longitude = parseFloat(longitude);
    if (ward !== undefined) updates.ward = ward;
    if (zone !== undefined) updates.zone = zone;

    if (fill_level !== undefined) {
      updates.fill_level = parseInt(fill_level, 10);
      const last_collected = new Date().toISOString();
      const { status, priorityScore } = calculateBinMetrics(updates.fill_level, last_collected);
      updates.status = status;
      updates.priority_score = priorityScore;
    }

    const { data: updatedBin, error } = await supabase
      .from('bins')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    res.status(200).json({ message: 'Bin updated successfully', bin: updatedBin });
  } catch (err) {
    next(err);
  }
};

// 5. DELETE /api/bins/:id - Remove a bin
export const deleteBin = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { error } = await supabase.from('bins').delete().eq('id', id);
    if (error) throw error;

    res.status(200).json({ message: `Bin ${id} deleted successfully` });
  } catch (err) {
    next(err);
  }
};

// 6. POST /api/bins/simulate-telemetry - Simulated IoT background job
export const simulateIoTTelemetry = async (req, res, next) => {
  try {
    const { data: bins, error: fetchError } = await supabase.from('bins').select('*');
    if (fetchError) throw fetchError;

    const updates = bins.map((bin) => {
      const increment = Math.floor(Math.random() * 14) + 2;
      const newFillLevel = Math.min(100, (bin.fill_level || 0) + increment);

      const { status, priorityScore } = calculateBinMetrics(newFillLevel, bin.last_collected);

      return {
        id: bin.id,
        latitude: bin.latitude,
        longitude: bin.longitude,
        ward: bin.ward,
        zone: bin.zone,
        fill_level: newFillLevel,
        status,
        priority_score: priorityScore,
        last_collected: bin.last_collected,
      };
    });

    const { data: updatedBins, error: updateError } = await supabase
      .from('bins')
      .upsert(updates)
      .select();

    if (updateError) throw updateError;

    res.status(200).json({
      message: 'IoT Telemetry simulation completed successfully.',
      updated_bins_count: updatedBins.length,
      critical_bins: updatedBins.filter((b) => b.status === 'Critical').length,
    });
  } catch (err) {
    next(err);
  }
};

// 7. POST /api/bins/reset-simulation - Reset all bins to fresh baseline state
export const resetBinData = async (req, res, next) => {
  try {
    const { error: deleteError } = await supabase
      .from('bins')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
      
    if (deleteError) throw deleteError;

    const newMockBins = generateMockBins(40);
    const { data: seededBins, error: seedError } = await supabase
      .from('bins')
      .insert(newMockBins)
      .select();

    if (seedError) throw seedError;

    res.status(200).json({
      message: 'Reset complete! Reseeded 40 mock bins.',
      count: seededBins.length,
    });
  } catch (err) {
    next(err);
  }
};