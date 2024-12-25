const socket = io();
let username = '';
let rolez = '';

document.getElementById('joinBtn').addEventListener('click', () => {
  username = document.getElementById('name').value;
  const role = document.getElementById('role').value;
  const room = document.getElementById('room').value;

  rolez = role;
  console.log(rolez);
  socket.emit('joinRoom', { room,  userid: '123456' , name: username, role });
});

socket.on('roomData', (roomData) => {
  document.getElementById('roomName').innerText = roomData.name;
  updateTimer(roomData.timer);
});

socket.on('roomFull', () => {
  alert('Room is full!');
});

socket.on('timerUpdate', (time) => {
  updateTimer(time);
});

socket.on('roomClosed', () => {
  alert('Room closed!');
});

// Sending chat messages
document.getElementById('sendBtn').addEventListener('click', () => {
  const message = document.getElementById('messageInput').value;
  const room = document.getElementById('room').value;

  const sender = { userid: '123456', name: username, role: rolez };

  console.log("Emitting 'chatMessage' with:", { room, message, sender }); // Debug log

  if (message.trim() !== '') {
    socket.emit('chatMessage', { room, message, sender });
    document.getElementById('messageInput').value = ''; // Clear input after sending
  }
});
// Handling message display
socket.on('message', ({ sender, message }) => {
  const messageElement = document.createElement('div');
  messageElement.classList.add('message');

  console.log(sender.userid);

  // Check if message contains a URL and convert it to a hyperlink
  const linkedMessage = message.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');

  if (sender.name === username) {
    messageElement.classList.add('own-message');
    messageElement.innerHTML = `You: ${linkedMessage}`;
  } else {
    messageElement.classList.add('other-message');
    messageElement.innerHTML = `${sender.name}: ${linkedMessage}`;
  }

  document.getElementById('messages').appendChild(messageElement);
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight; // Auto-scroll
});

// Sending files
document.getElementById('sendFileBtn').addEventListener('click', () => {
  const fileInput = document.getElementById('fileInput');
  const file = fileInput.files[0];
  const room = document.getElementById('room').value;

  const sender = { userid: '123456', name: username, role: rolez };

  if (file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      socket.emit('sendFile', { room, fileName: file.name, fileData: e.target.result, sender });
    };
    reader.readAsDataURL(file); // Convert file to Base64 format
    fileInput.value = ''; // Clear file input after sending
  }
});

// Receiving files
socket.on('fileMessage', ({ sender, fileName, fileUrl }) => {
  const messageElement = document.createElement('div');
  messageElement.classList.add('message');

  const fileLink = `<a href="${fileUrl}" download="${fileName}">Download ${fileName}</a>`;

  if (sender.name === username) {
    messageElement.classList.add('own-message');
    messageElement.innerHTML = `You sent a file: ${fileLink}`;
  } else {
    messageElement.classList.add('other-message');
    messageElement.innerHTML = `${sender.name} sent a file: ${fileLink}`;
  }

  document.getElementById('messages').appendChild(messageElement);
  document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight; // Auto-scroll
});

function updateTimer(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  document.getElementById('timer').innerText = `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
}

document.querySelectorAll('button[data-minutes]').forEach(button => {
  button.addEventListener('click', () => {
    const minutes = parseInt(button.getAttribute('data-minutes'));
    const room = document.getElementById('room').value;
    socket.emit('addTime', { room, minutes });
  });
});
