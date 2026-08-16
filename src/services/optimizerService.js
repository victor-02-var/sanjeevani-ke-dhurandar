import fetch from 'node-fetch';

const OPTIMIZER_URL = process.env.OPTIMIZER_URL || 'http://localhost:8000';

/**
 * Calls Python FastAPI OR-Tools engine to solve VRP with Capacity and Territory Penalties
 */
export const solveVehicleRouting = async (vehicles, locations, distanceMatrix, durationMatrix) => {
  const payload = {
    vehicles,
    locations,
    distanceMatrix,
    durationMatrix,
  };

  // Targeting /solve-vrp endpoint as defined in Python FastAPI
  const response = await fetch(`${OPTIMIZER_URL}/solve-vrp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errorMessage = response.statusText;
    try {
      const errorData = await response.json();
      errorMessage = errorData.detail || response.statusText;
    } catch {
      // Fallback if response body isn't JSON
    }
    throw new Error(`Optimizer Service Error: ${errorMessage}`);
  }

  return await response.json();
};