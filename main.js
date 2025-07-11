// ---- Config ----
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
// Using the standard v2 endpoints for OpenRouteService
const ORS_API_KEY = "5b3ce3597851110001cf62480254e0b699d0425295d7d53103384a68";
const ORS_DIRECTIONS_URL = "https://api.openrouteservice.org/v2/directions";

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
  showDirections("Optimizing route...");
  
  try {
    // For simplicity, we'll use a different approach for optimization
    // Just reorder the waypoints based on proximity
    const optimizedIndices = simpleOptimize(coords);
    
    // Reorder addresses and coords based on optimized indices
    let newOrderAddresses = [addresses[0]]; // Start remains the same
    let newOrderCoords = [coords[0]]; // Start coords remain the same
    
    // Add stops in optimized order
    for (let i = 0; i < optimizedIndices.length; i++) {
      const idx = optimizedIndices[i];
      newOrderAddresses.push(addresses[idx]);
      newOrderCoords.push(coords[idx]);
    }
    
    // Add end address
    newOrderAddresses.push(addresses[addresses.length - 1]);
    newOrderCoords.push(coords[coords.length - 1]);
    
    // Update UI order for stops
    updateStopsUI(newOrderAddresses.slice(1, -1));
    
    // Draw optimized route
    showDirections("Fetching optimized route...");
    await drawRoute(newOrderCoords, newOrderAddresses);
  } catch (error) {
    showDirections(`Error during optimization: ${error.message}`);
  }
}

// Simple greedy optimization algorithm
function simpleOptimize(coords) {
  // Only optimize the stops, not start/end
  if (coords.length <= 2) return [];
  
  const start = coords[0];
  const midPoints = coords.slice(1, coords.length - 1);
  const result = [];
  const used = new Set();
  
  let currentPoint = start;
  
  // For each stop, find the nearest unused one
  while (used.size < midPoints.length) {
    let minDist = Infinity;
    let minIndex = -1;
    
    for (let i = 0; i < midPoints.length; i++) {
      if (!used.has(i)) {
        const dist = distance(currentPoint, midPoints[i]);
        if (dist < minDist) {
          minDist = dist;
          minIndex = i;
        }
      }
    }
    
    if (minIndex !== -1) {
      result.push(minIndex + 1); // +1 because we're skipping the start point
      used.add(minIndex);
      currentPoint = midPoints[minIndex];
    }
  }
  
  return result;
}

// Calculate distance between two points [lon, lat]
function distance(point1, point2) {
  const [lon1, lat1] = point1;
  const [lon2, lat2] = point2;
  
  // Simple Euclidean distance for simplicity
  // In a real-world scenario, you might want to use Haversine formula
  return Math.sqrt(Math.pow(lon1 - lon2, 2) + Math.pow(lat1 - lat2, 2));
}

// ---- Draw Route ----
async function drawRoute(coords, addresses) {
  try {
    // Format coordinates for ORS API
    const coordinates = coords.map(c => [parseFloat(c[0]), parseFloat(c[1])]);
    
    // Build the URL with profile and API key
    const profile = "driving-car";
    const url = `${ORS_DIRECTIONS_URL}/${profile}`;
    
    const body = {
      coordinates: coordinates,
      format: "geojson",
      instructions: true
    };
    
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": ORS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "application/json, application/geo+json, application/gpx+xml"
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      let errMsg = `Route API error: ${res.status} ${res.statusText}`;
      try {
        const errData = await res.json();
        if (errData && errData.error) {
          errMsg += ` - ${errData.error.message || errData.error}`;
        }
      } catch (e) {
        // If we can't parse the error response, just use the status
      }
      showDirections(errMsg);
      
      // Try a simpler approach - direct line
      drawDirectLine(coords);
      drawMarkersSimple(coords, addresses);
      return;
    }
    
    const data = await res.json();
    if (!data.features || !data.features[0]) {
      showDirections("Could not fetch route.");
      drawDirectLine(coords);
      drawMarkersSimple(coords, addresses);
      return;
    }
    
    const line = data.features[0].geometry.coordinates;
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = L.polyline(line.map(c => [c[1], c[0]]), { color: "#297ffb", weight: 6 }).addTo(map);
    fitMapToRoute(line);
    drawMarkersSimple(coords, addresses);
    
    if (
      data.features[0].properties &&
      data.features[0].properties.segments &&
      data.features[0].properties.segments[0].steps
    ) {
      showInstructions(data.features[0].properties.segments[0].steps);
    } else {
      showDirections("Route fetched, but no turn-by-turn instructions available.");
    }
  } catch (error) {
    console.error("Error in drawRoute:", error);
    showDirections(`Error drawing route: ${error.message}`);
    
    // Fall back to direct line
    drawDirectLine(coords);
    drawMarkersSimple(coords, addresses);
  }
}

// Fallback: draw direct lines between points
function drawDirectLine(coords) {
  const points = coords.map(c => [c[1], c[0]]);
  if (routeLayer) map.removeLayer(routeLayer);
  routeLayer = L.polyline(points, { color: "#ff6b6b", weight: 4, dashArray: "5, 10" }).addTo(map);
  fitMapToRoute(coords.map(c => [c[0], c[1]]));
  showDirections("Using direct lines between points (API route not available).");
}

// ---- Utility: Markers, Fit, Clear ----
function drawMarkersSimple(coords, addresses) {
  // Clear existing markers
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  
  // Create new markers
  for (let i = 0; i < coords.length; i++) {
    const lat = coords[i][1];
    const lon = coords[i][0];
    
    // Create standard markers with different popup content based on position
    let popupContent = addresses[i];
    if (i === 0) {
      popupContent = `<strong>Start:</strong> ${addresses[i]}`;
    } else if (i === coords.length - 1) {
      popupContent = `<strong>End:</strong> ${addresses[i]}`;
    } else {
      popupContent = `<strong>Stop ${i}:</strong> ${addresses[i]}`;
    }
    
    // Create the marker with popup
    const marker = L.marker([lat, lon]).bindPopup(popupContent).addTo(map);
    markers.push(marker);
  }
}

function fitMapToRoute(coords) {
  try {
    const latlngs = coords.map(c => [c[1], c[0]]);
    const bounds = L.latLngBounds(latlngs);
    map.fitBounds(bounds, { padding: [40, 40] });
  } catch (error) {
    console.error("Error fitting map to route:", error);
    // If we can't fit to the route, zoom out to show all points
    map.setView([40, -100], 4);
  }
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
  stopsList.innerHTML = '<label>Stops</label>';
  for (let stop of newStops) {
    addStopInput(stop);
  }
}
