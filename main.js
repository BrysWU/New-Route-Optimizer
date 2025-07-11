// ---- Config ----
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const ORS_ROUTE_URL = "https://api.openrouteservice.org/v2/directions/driving-car/geojson";
const ORS_OPTIMIZE_URL = "https://api.openrouteservice.org/optimization";
const ORS_API_KEY = "5b3ce3597851110001cf62480254e0b699d0425295d7d53103384a68"; // <-- Insert your OpenRouteService API key here for live demo!
// Get a free key: https://openrouteservice.org/sign-up/

// ---- Map Setup ----
let map = L.map('map').setView([40, -100], 4);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

let routeLayer = null;
let markers = [];

// ---- Sidebar UI ----
const stopsList = document.getElementById('stops-list');
const addStopBtn = document.getElementById('add-stop');
let stopCount = 0;

function addStopInput(value = "") {
  stopCount++;
  const row = document.createElement("div");
  row.className = "stop-input-row";
  row.innerHTML = `<input type="text" class="stop" placeholder="Stop address" value="${value}">
    <button type="button" class="remove-stop" title="Remove">×</button>`;
  row.querySelector('.remove-stop').onclick = () => {
    row.remove();
    stopCount--;
  };
  stopsList.appendChild(row);
}

addStopBtn.onclick = () => addStopInput();

// Start with one stop input for convenience
addStopInput();

// ---- Form Handling ----
document.getElementById('route-form').onsubmit = async function(e) {
  e.preventDefault();
  await handleRoute(false);
};

document.getElementById('optimize-route').onclick = async function() {
  await handleRoute(true);
};

// ---- Geocoding Addresses ----
async function geocodeAddress(address) {
  const params = new URLSearchParams({
    q: address,
    format: "json",
    limit: 1
  });
  const url = `${NOMINATIM_URL}?${params.toString()}`;
  const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
  const data = await res.json();
  if (data && data[0]) {
    return [parseFloat(data[0].lon), parseFloat(data[0].lat)];
  }
  return null;
}

// ---- Route & Optimization Handler ----
async function handleRoute(optimize) {
  clearRoute();

  const start = document.getElementById('start').value.trim();
  const end = document.getElementById('end').value.trim();
  const stops = Array.from(document.querySelectorAll('.stop')).map(i => i.value.trim()).filter(s => s);

  if (!start || !end) {
    alert("Start and End addresses are required.");
    return;
  }

  // Geocode all addresses
  showDirections("Geocoding addresses...");
  const addresses = [start, ...stops, end];
  let coords = [];
  for (let addr of addresses) {
    const c = await geocodeAddress(addr);
    if (!c) {
      showDirections(`Could not find: "${addr}"`);
      return;
    }
    coords.push(c);
  }

  // If not optimizing, just draw the straight route
  if (!optimize) {
    showDirections("Fetching route...");
    await drawRoute(coords, addresses);
    return;
  }

  // --------- Optimization ---------
  if (!ORS_API_KEY) {
    showDirections('Optimization requires an OpenRouteService API key. <a href="https://openrouteservice.org/sign-up/" target="_blank">Get one here</a> and set it in main.js');
    return;
  }

  showDirections("Optimizing route...");

  // Prepare jobs/vehicles for ORS Optimization
  // Start/end are fixed, stops can be reordered
  const jobs = stops.map((stop, i) => ({
    id: i + 1,
    location: coords[i + 1], // stops start from index 1
    address: { location_id: `stop_${i + 1}`, name: stop }
  }));

  const vehicle = {
    id: 1,
    profile: "driving-car",
    start: coords[0],
    end: coords[coords.length - 1]
  };

  const orsBody = {
    jobs: jobs,
    vehicles: [vehicle]
  };

  const res = await fetch(ORS_OPTIMIZE_URL, {
    method: "POST",
    headers: {
      "Authorization": ORS_API_KEY,
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(orsBody)
  });

  if (!res.ok) {
    let msg = "Optimization API error: " + res.statusText;
    try {
      const errData = await res.json();
      if (errData && errData.error) {
        msg += "<br>" + errData.error;
      }
    } catch {}
    showDirections(msg);
    return;
  }
  const optData = await res.json();
  if (!optData.routes || !optData.routes[0]) {
    showDirections("Could not optimize route.");
    return;
  }

  // Get new order of stops
  const routeSteps = optData.routes[0].steps;
  let newOrderAddresses = [start];
  let newOrderCoords = [coords[0]];
  for (let step of routeSteps) {
    if (step.type === "job") {
      const idx = jobs.findIndex(j => j.id === step.id);
      newOrderAddresses.push(stops[idx]);
      newOrderCoords.push(coords[idx + 1]);
    }
  }
  newOrderAddresses.push(end);
  newOrderCoords.push(coords[coords.length - 1]);

  // Update UI order for stops
  updateStopsUI(newOrderAddresses.slice(1, -1));

  // Draw optimized route
  showDirections("Fetching optimized route...");
  await drawRoute(newOrderCoords, newOrderAddresses);
}

// ---- Draw Route ----
async function drawRoute(coords, addresses) {
  if (!ORS_API_KEY) {
    // Use basic linestring if no API key
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.polyline(coords.map(c => [c[1], c[0]]), { color: "#297ffb", weight: 5 }).addTo(map);
    fitMapToRoute(coords);
    drawMarkers(coords, addresses);
    showDirections("Route shown (no turn-by-turn directions without API key)");
    return;
  }

  // Use ORS Directions API for detailed route
  const body = {
    coordinates: coords,
    instructions: true
  };
  const res = await fetch(ORS_ROUTE_URL, {
    method: "POST",
    headers: {
      "Authorization": ORS_API_KEY,
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    let msg = "Route API error: " + res.statusText;
    try {
      const errData = await res.json();
      if (errData && errData.error) {
        msg += "<br>" + errData.error;
      }
    } catch {}
    showDirections(msg);
    return;
  }
  const data = await res.json();
  if (!data.features || !data.features[0]) {
    showDirections("Could not fetch route.");
    return;
  }
  const line = data.features[0].geometry.coordinates;
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.polyline(line.map(c => [c[1], c[0]]), { color: "#297ffb", weight: 6 }).addTo(map);
  fitMapToRoute(line);
  drawMarkers(coords, addresses);
  if (
    data.features[0].properties &&
    data.features[0].properties.segments &&
    data.features[0].properties.segments[0].steps
  ) {
    showInstructions(data.features[0].properties.segments[0].steps);
  } else {
    showDirections("Route fetched, but no turn-by-turn instructions available.");
  }
}

// ---- Utility: Markers, Fit, Clear ----
function drawMarkers(coords, addresses) {
  // Remove old
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  for (let i = 0; i < coords.length; i++) {
    let marker = L.marker([coords[i][1], coords[i][0]])
      .bindPopup(addresses[i])
      .addTo(map);
    markers.push(marker);
  }
}

function fitMapToRoute(coords) {
  const latlngs = coords.map(c => [c[1], c[0]]);
  const bounds = L.latLngBounds(latlngs);
  map.fitBounds(bounds, { padding: [40, 40] });
}

function clearRoute() {
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = null;
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  showDirections("");
}

// ---- Directions/Instructions ----
function showDirections(html) {
  document.getElementById("directions").innerHTML = html;
}

function showInstructions(steps) {
  let html = "<strong>Turn-by-turn Directions:</strong><ol>";
  for (let step of steps) {
    html += `<li>${step.instruction} <span style="color:#666;">(${(step.distance/1000).toFixed(2)} km)</span></li>`;
  }
  html += "</ol>";
  showDirections(html);
}

// ---- UI: Update Stops Order ----
function updateStopsUI(newStops) {
  // Remove all current stops
  stopsList.innerHTML = '<label>Stops</label>';
  for (let stop of newStops) {
    addStopInput(stop);
  }
}

// ---- Demo Info ----
if (!ORS_API_KEY) {
  showDirections('For route optimization and turn-by-turn directions, insert your OpenRouteService API key in <code>main.js</code>. <a href="https://openrouteservice.org/sign-up/" target="_blank">Get one here.</a>');
}
