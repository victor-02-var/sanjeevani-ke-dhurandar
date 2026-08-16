const BASE_LAT = 19.9975;
const BASE_LNG = 73.7898;

const DRIVERS = [
  'Ramesh Kumar', 'Suresh Patil', 'Amit Sharma', 'Vijay Shinde',
  'Prakash Jadhav', 'Ganesh Pawar', 'Sachin Verma', 'Dinesh More'
];

export const generateMockVehicles = () => {
  return DRIVERS.map((driver, index) => {
    const idNum = String(index + 1).padStart(2, '0');
    return {
      driver_name: driver,
      latitude: parseFloat((BASE_LAT + (Math.random() - 0.5) * 0.05).toFixed(6)),
      longitude: parseFloat((BASE_LNG + (Math.random() - 0.5) * 0.05).toFixed(6)),
      speed: Math.floor(Math.random() * 30) + 15, // Speed in km/h
      status: index % 3 === 0 ? 'Idle' : 'Collecting', // Statuses: Idle, Collecting, Maintenance
      assigned_bins: []
    };
  });
};