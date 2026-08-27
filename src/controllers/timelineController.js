import { supabaseAdmin as supabase } from '../config/supabase.js';

// Helper — called internally to seed the initial timeline when a complaint is filed
export const seedInitialTimeline = async (complaintId) => {
  const events = [
    { event: 'Complaint Filed', description: 'Your complaint has been received and logged.', status: 'Open' },
    { event: 'Under Review', description: 'Admin is reviewing the complaint details.', status: 'Under Review' },
    { event: 'Driver Assigned', description: 'A driver has been assigned to address the complaint.', status: 'Assigned' },
    { event: 'Work In Progress', description: 'Driver is on the way to the reported location.', status: 'In Progress' },
    { event: 'Resolved', description: 'The issue has been resolved and verified.', status: 'Resolved' },
  ];

  const rows = events.map((e) => ({ ...e, complaint_id: complaintId }));
  await supabase.from('complaint_timelines').insert(rows);
};

// GET /api/complaints/:id/timeline
export const getComplaintTimeline = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: complaint, error: cErr } = await supabase
      .from('complaints')
      .select('id, status, timeline_visible')
      .eq('id', id)
      .single();

    if (cErr || !complaint) return res.status(404).json({ error: 'Complaint not found.' });

    const { data: timeline, error: tErr } = await supabase
      .from('complaint_timelines')
      .select('id, event, description, status, created_at')
      .eq('complaint_id', id)
      .order('created_at', { ascending: true });

    if (tErr) throw tErr;

    res.status(200).json({
      complaint_id: id,
      current_status: complaint.status,
      timeline_visible: complaint.timeline_visible,
      timeline,
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/complaints/:id/timeline/toggle — Admin toggles timeline visibility
export const toggleTimelineVisibility = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { data: complaint, error: fetchErr } = await supabase
      .from('complaints')
      .select('timeline_visible')
      .eq('id', id)
      .single();

    if (fetchErr || !complaint) return res.status(404).json({ error: 'Complaint not found.' });

    const newVisibility = !complaint.timeline_visible;

    const { error: updateErr } = await supabase
      .from('complaints')
      .update({ timeline_visible: newVisibility })
      .eq('id', id);

    if (updateErr) throw updateErr;

    res.status(200).json({
      success: true,
      complaint_id: id,
      timeline_visible: newVisibility,
      message: `Timeline is now ${newVisibility ? 'visible' : 'hidden'} for citizens.`,
    });
  } catch (err) {
    next(err);
  }
};
