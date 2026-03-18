const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${protocol}//${window.location.host}`);

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);

  document.getElementById("status").innerHTML = `
    🚑 Ambulance Distance: <b>${data.distance}</b><br>
    ⏱ ETA: <b>${data.eta}</b>
  `;
};