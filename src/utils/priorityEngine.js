/**
 * Calculates bin status and priority score based on fill level and last collection time.
 * @param {number} fillLevel - Current fill level percentage (0 - 100)
 * @param {string|Date} lastCollected - Timestamp of last collection
 * @param {number} complaintCount - Number of open complaints nearby (default 0)
 */
export const calculateBinMetrics = (fillLevel, lastCollected, complaintCount = 0) => {
  // 1. Determine Status based on Fill Level thresholds
  let status = 'Normal';
  if (fillLevel >= 80) {
    status = 'Critical';
  } else if (fillLevel >= 50) {
    status = 'Warning';
  }

  // 2. Calculate time elapsed since last collection (in hours)
  const lastCollectedDate = new Date(lastCollected || Date.now());
  const hoursSinceCollection = Math.max(0, (Date.now() - lastCollectedDate.getTime()) / (1000 * 60 * 60));

  // 3. Calculate Priority Score (0 - 100)
  // Weights: Fill Level (50%), Time Elapsed (30%), Complaints (20%)
  const fillComponent = fillLevel * 0.5;
  const timeComponent = Math.min(hoursSinceCollection * 1.25, 30);
  const complaintComponent = Math.min(complaintCount * 10, 20);

  const priorityScore = Math.min(100, Math.round(fillComponent + timeComponent + complaintComponent));

  return { status, priorityScore };
};