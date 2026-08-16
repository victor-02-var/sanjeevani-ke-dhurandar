import { calculateBinMetrics } from './priorityEngine.js';

// Base city center coordinates (Default: Nashik area grid)
const BASE_LAT = 19.9975;
const BASE_LNG = 73.7898;

export const generateMockBins = (count = 40) => {
  const bins = [];

  for (let i = 1; i <= count; i++) {
    // Generate slight offset coordinates within ~5-10km
    const latitude = parseFloat((BASE_LAT + (Math.random() - 0.5) * 0.08).toFixed(6));
    const longitude = parseFloat((BASE_LNG + (Math.random() - 0.5) * 0.08).toFixed(6));
    
    // Simulated fill level between 10% and 98%
    const fill_level = Math.floor(Math.random() * 89) + 10;
    
    // Simulated last collected time between 1 and 48 hours ago
    const hoursAgo = Math.floor(Math.random() * 48) + 1;
    const last_collected = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();

    const { status, priorityScore } = calculateBinMetrics(fill_level, last_collected);

    bins.push({
      latitude,
      longitude,
      fill_level,
      status,
      last_collected,
      priority_score: priorityScore
    });
  }

  return bins;
};