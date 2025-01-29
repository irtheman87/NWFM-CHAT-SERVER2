import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import cors from 'cors';
const { Buffer } = require('buffer'); // Ensure `Buffer` is available

const app = express();
const server = http.createServer(app);

// Increase the payload size limit for Express
app.use(express.json({ limit: '50mb' })); // Increase JSON payload limit
app.use(express.urlencoded({ limit: '50mb', extended: true })); // Increase URL-encoded payload limit

// Enable CORS for Express routes
app.use(cors({
  origin: '*', // Allow all origins; replace '*' with specific origin(s)
  methods: ['GET', 'POST'], // Restrict allowed methods
  allowedHeaders: ['Content-Type', 'Authorization'], // Specify allowed headers
  credentials: true, // Allow cookies if required
}));

// Configure Socket.IO with a larger message size limit
const io = new Server(server, {
  cors: {
    origin: '*', // Allow all origins; replace '*' with specific origin(s) for security
    methods: ['GET', 'POST'], // Allowed HTTP methods
    allowedHeaders: ['Content-Type', 'Authorization'], // Allowed headers
    credentials: true, // Include credentials if needed
  },
  connectionStateRecovery: { maxDisconnectionDuration: 60 * 60, skipMiddlewares: true },
  maxHttpBufferSize: 1e8, // Increase Socket.IO message size limit to 100MB
});


interface User {
  userid: string;
  name: string;
  role: 'user' | 'consultant' | 'admin';
}

const rooms: { [key: string]: { users: User[], timer: number } } = {};

const userSocketMap: { [key: string]: string } = {};

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);

  // Event to join a room with user details
  socket.on('joinRoom', ({ room, userid, name, role }: { room: string, userid: string, name: string, role: 'user' | 'consultant' | 'admin' }) => {
    if (!rooms[room]) {
      rooms[room] = { users: [], timer: 600 }; // Default 10 min timer (600 seconds)
    }

    if (rooms[room].users.length < 4) {
      const user: User = { userid, name, role };
      rooms[room].users.push(user);
      socket.join(room);
      userSocketMap[socket.id] = userid; // Map socket.id to userid
      // Notify the room about the current users and their roles
      io.to(room).emit('roomData', rooms[room]);
      console.log(`${name} joined room ${room} as ${role}`);
    } else {
      socket.emit('roomFull');
    }
  });


    socket.on('joinQueueRoom', ({ room, userid, name, role }: { room: string, userid: string, name: string, role: 'user' | 'consultant' | 'admin' }) => {
    if (!rooms[room]) {
      rooms[room] = { users: [], timer: 600 }; // Default 10 min timer (600 seconds)
    }

    if (rooms[room].users.length < 2) {
      const user: User = { userid, name, role };
      rooms[room].users.push(user);
      socket.join(room);
      userSocketMap[socket.id] = userid; // Map socket.id to userid
      // Notify the room about the current users and their roles
      io.to(room).emit('roomData', rooms[room]);
      console.log(`${name} joined room ${room} as ${role}`);
    } else {
      socket.emit('roomFull');
    }
  });

  // Handle chat messages
  socket.on('chatMessage', async ({ room, message, sender }) => {
    console.log("Received 'chatMessage' event with:", { room, message, sender }); // Debug log
  
    io.to(room).emit('message', { sender, message });
  
    // Prepare data to send to the API
    const messageData = {
      mid: sender.mid,
      uid: sender.userid,
      role: sender.role,
      name: sender.name,
      type: sender.type,
      room,
      message,
      ...(sender.replyto && { replyto: sender.replyto }), // Include if replyto exists
      ...(sender.replytoId && { replytoId: sender.replytoId }), // Include if replyId exists
      ...(sender.replytousertype && { replytousertype: sender.replytousertype }), // Include if replytousertype exists
      ...(sender.recommendations && { recommendations: sender.recommendations }), // Include if replytousertype exists
    };
  
    console.log("Attempting to save message:", messageData); // Logging for debugging
  
    try {
      // Send the message to the save endpoint
      const response = await axios.post('https://api.nollywoodfilmmaker.com/api/chat/save', messageData);
      console.log('Message saved to API:', response.data);
    } catch (error) {
      console.error('Error saving message to API:', error);
    }
  });
  
  
  


  // Handle file sharing
  socket.on('sendFile', async ({ room, fileName, fileData, sender }) => {
    try {
      // Convert `fileData` from Base64 to Buffer if it’s a string
      if (typeof fileData === 'string') {
        // Remove any prefix from `fileData` if it is a DataURL (e.g., "data:image/png;base64,")
        const base64Data = fileData.split(',')[1];
        fileData = Buffer.from(base64Data, 'base64');
      }
  
      // Check if `fileData` is now a Buffer
      if (!(fileData instanceof Buffer)) {
        console.error('fileData must be a Buffer');
        io.to(room).emit('error', { message: 'File data format is incorrect' });
        return;
      }
  
      // Prepare the form data for the upload request
      const formData = new FormData();
      formData.append('file', fileData, {
        filename: fileName || 'uploadedFile', // Default filename if fileName is missing
        contentType: 'application/octet-stream', // Specify content type
      });
      formData.append('mid', sender.mid);
      formData.append('uid', sender.userid);
      formData.append('role', sender.role);
      formData.append('name', sender.name);
      formData.append('type', sender.type);
      formData.append('room', room);
  
      // Include `replyto` and `replytoId` if they exist in sender
      if (sender.replyto) formData.append('replyto', sender.replyto);
      if (sender.replytoId) formData.append('replytoId', sender.replytoId);
      if (sender.replytousertype) formData.append('replytousertype', sender.replytousertype);
  
      // Send the file to the upload API with progress tracking
      const response = await axios.post('https://api.nollywoodfilmmaker.com/api/chat/upload', formData, {
        headers: {
          ...formData.getHeaders(),
        },
        onUploadProgress: (progressEvent) => {
          // Safely calculate the upload progress percentage
          if (progressEvent.total !== undefined) {
            const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            console.log(`Upload progress for ${fileName}: ${progress}%`);


            // Emit the progress to the client
            io.to(room).emit('uploadProgress', {
              sender,
              fileName,
              progress, // Progress percentage (0-100)
            });
          } else {
            // Handle the case where `total` is undefined
            console.warn('Upload progress total is undefined. Progress cannot be calculated.');
          }
        },
      });
  
      // Emit the file message to the room once the file is saved successfully
      io.to(room).emit('fileMessage', {
        sender,
        fileName,
        fileUrl: response.data.file.path, // Get the file URL from the response
        replyto: sender.replyto || null, // Include replyto in emitted message if exists
        replytoId: sender.replytoId || null, // Include replytoId in emitted message if exists
        replytousertype: sender.replytousertype || null,
        timestamp: response.data.file.timestamp,
      });
    } catch (error) {
      console.error('Error uploading file:', error);
      io.to(room).emit('error', { message: 'Failed to upload file' });
    }
  });
  

   socket.on('triggerRefresh', async ({ room }) => {
        if (rooms[room]) {
            console.log(`Emitting refresh event to room: ${room}`);
            io.to(room).emit('refresh', { message: 'Refresh the room data or UI' });
        } else {
            socket.emit('error', { message: `Room ${room} does not exist` });
        }
    });


    // Handle typing event
    socket.on('typing', async ({ room, sender }) => {
      if (rooms[room]) {
        console.log(`User ${sender.userId} is typing in room: ${room}`);
        io.to(room).emit('istyping', { userId: sender.userId, message: `${sender.name} is typing...` });
      } else {
        socket.emit('error', { message: `Room ${room} does not exist` });
      }
    });

    // Handle stopped typing event
    socket.on('stopped', async ({ room, sender }) => {
      if (rooms[room]) {
        console.log(`User ${sender.userId} stopped typing in room: ${room}`);
        io.to(room).emit('stoptyping', { userId: sender.userId, message: `${sender.name} stopped typing` });
      } else {
        socket.emit('error', { message: `Room ${room} does not exist` });
      }
    });


    socket.on('triggerPing', async ({ room }) => {
      if (rooms[room]) {
          console.log(`Emitting Stay event to room: ${room}`);
          io.to(room).emit('roomPing', { message: 'Stay In Room' });
      } else {
          socket.emit('error', { message: `Room ${room} does not exist` });
      }
  });


  // Add extra time to the room's timer
  socket.on('addTime', async ({ room, minutes, reference }: { room: string, minutes: number, reference: string }) => {
    if (!rooms[room]) {
      console.log(`Room ${room} does not exist.`);
      return;
    }

    try {
      // Make a request to check the transaction status by reference
      const response = await axios.get(`https://api.nollywoodfilmmaker.com/api/users/gettranstat/${reference}`);
      
      // Verify if the status is 'completed'
      if (response.data.status === 'completed') {
        rooms[room].timer += minutes * 60; // Convert minutes to seconds
        io.to(room).emit('timerUpdate', rooms[room].timer);
        console.log(`Timer extended by ${minutes} minutes for room ${room}.`);
      } else {
        console.log(`Transaction status for reference ${reference} is not completed. Time extension denied.`);
        io.to(room).emit('error', { message: 'Transaction not completed. Cannot extend time.' });
      }
    } catch (error) {
      console.error('Error checking transaction status:', error);
      io.to(room).emit('error', { message: 'Failed to check transaction status' });
    }
  });

  // Handle user disconnection
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const userid = userSocketMap[socket.id];
    delete userSocketMap[socket.id]; // Clean up mapping
    for (const room in rooms) {
      const userIndex = rooms[room].users.findIndex(user => user.userid === userid);
      if (userIndex !== -1) {
        const removedUser = rooms[room].users.splice(userIndex, 1)[0];
        io.to(room).emit('roomData', rooms[room]);
        console.log(`User ${removedUser.name} removed from room ${room}`);
        break;
      }
    }
  });
});

// Timer that decreases every second
setInterval(() => {
  Object.keys(rooms).forEach(room => {
    if (rooms[room].timer > 0) {
      rooms[room].timer--;
      io.to(room).emit('timerUpdate', rooms[room].timer);
    } else {
      io.to(room).emit('roomClosed');
      rooms[room].users = [];
    }
  });
}, 1000);

app.get('/export', (req, res) => {
  console.log("Export endpoint accessed"); // Debug log
  console.log('🎄 Merry Christmas 🎅'); // Festive log
  res.json({
    message: "Export functionality activated!",
    status: "success",
    date: new Date().toISOString(),
  });
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
