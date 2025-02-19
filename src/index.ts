import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import cors from 'cors';
import { log } from 'console';
const { Buffer } = require('buffer'); // Ensure `Buffer` is available
import fs from 'fs';

const app = express();
const server = http.createServer(app);

// Increase the payload size limit for Express
app.use(express.json({ limit: '500mb' })); // Increase JSON payload limit
app.use(express.urlencoded({ limit: '500mb', extended: true })); // Increase URL-encoded payload limit

// Enable CORS for Express routes
app.use(
  cors({
    origin: '*', // Allow all origins; replace '*' with specific origin(s)
    methods: ['GET', 'POST'], // Restrict allowed methods
    allowedHeaders: ['Content-Type', 'Authorization'], // Specify allowed headers
    credentials: true, // Allow cookies if required
  })
);

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

const rooms: { [key: string]: { users: User[]; timer: number } } = {};
const userSocketMap: { [key: string]: string } = {};

// Ensure uploads directory exists for storing file chunks temporarily
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir);
}

// Global object to track ongoing file uploads
const fileUploads: {
  [uploadId: string]: {
    fileName: string;
    totalChunks: number;
    receivedChunks: number;
    sender: any;
    room: string;
  };
} = {};

// Helper function to merge file chunks
const mergeChunks = async (uploadId: string, totalChunks: number, outputFilePath: string) => {
  const writeStream = fs.createWriteStream(outputFilePath);

  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(uploadsDir, `${uploadId}_chunk_${i}`);
    if (fs.existsSync(chunkPath)) {
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
      fs.unlinkSync(chunkPath); // Delete the chunk after merging
    } else {
      throw new Error(`Missing chunk file: ${chunkPath}`);
    }
  }

  writeStream.end();

  return new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
};

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);

  // Event to join a room with user details
  socket.on(
    'joinRoom',
    ({ room, userid, name, role }: { room: string; userid: string; name: string; role: 'user' | 'consultant' | 'admin' }) => {
      if (!rooms[room]) {
        rooms[room] = { users: [], timer: 12000 }; // Default 10 min timer (600 seconds)
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
    }
  );

  socket.on(
    'joinQueueRoom',
    ({ room, userid, name, role }: { room: string; userid: string; name: string; role: 'user' | 'consultant' | 'admin' }) => {
      if (!rooms[room]) {
        rooms[room] = { users: [], timer: 12000 };
      }

      if (rooms[room].users.length < 2) {
        const user: User = { userid, name, role };
        rooms[room].users.push(user);
        socket.join(room);
        userSocketMap[socket.id] = userid;
        io.to(room).emit('roomData', rooms[room]);
        console.log(`${name} joined room ${room} as ${role}`);
      } else {
        socket.emit('roomFull');
      }
    }
  );

  // Handle chat messages (unchanged)
  socket.on('chatMessage', async ({ room, message, sender }) => {
    console.log("Received 'chatMessage' event with:", { room, message, sender });
    io.to(room).emit('message', { sender, message });

    const messageData = {
      mid: sender.mid,
      uid: sender.userid,
      role: sender.role,
      name: sender.name,
      type: sender.type,
      room,
      message,
      ...(sender.replyto && { replyto: sender.replyto }),
      ...(sender.replytoId && { replytoId: sender.replytoId }),
      ...(sender.replytousertype && { replytousertype: sender.replytousertype }),
      ...(sender.replytochattype && { replytochattype: sender.replytochattype }),
      ...(sender.recommendations && { recommendations: sender.recommendations }),
    };

    console.log('Attempting to save message:', messageData);
    
    try {
      const response = await axios.post('https://api.nollywoodfilmmaker.com/api/chat/save', messageData);
      console.log('Message saved to API:', response.data);
    } catch (error) {
      console.error('Error saving message to API:', error);
    }
  });

  socket.on(
    'sendFileChunk',
    async (data: {
      uploadId: string;
      fileName: string;
      chunkIndex: number;
      totalChunks: number;
      fileData: string | Buffer;
      sender: any;
      room: string;
    }) => {
      const { uploadId, fileName, chunkIndex, totalChunks, fileData, sender, room } = data;

      // Convert fileData from Base64 to Buffer if needed
      let chunkBuffer: Buffer;
      if (typeof fileData === 'string') {
        const base64Data = fileData.includes(',') ? fileData.split(',')[1] : fileData;
        chunkBuffer = Buffer.from(base64Data, 'base64');
      } else {
        chunkBuffer = fileData;
      }

      // Save the chunk to disk
      const chunkPath = path.join(uploadsDir, `${uploadId}_chunk_${chunkIndex}`);
      fs.writeFileSync(chunkPath, chunkBuffer);
      console.log(`Saved chunk ${chunkIndex} for upload ${uploadId}`);

      // Initialize tracking for this upload if not already done
      if (!fileUploads[uploadId]) {
        fileUploads[uploadId] = {
          fileName,
          totalChunks,
          receivedChunks: 0,
          sender,
          room,
        };
      }
      fileUploads[uploadId].receivedChunks++;

      // If all chunks have been received, merge them and upload
      if (fileUploads[uploadId].receivedChunks === totalChunks) {
        const mergedFilePath = path.join(uploadsDir, `${uploadId}_merged_${fileName}`);
        try {
          await mergeChunks(uploadId, totalChunks, mergedFilePath);
          console.log(`Chunks merged for upload ${uploadId}`);

          // Prepare form data for upload
          const mergedFileBuffer = fs.readFileSync(mergedFilePath);
          const formData = new FormData();
          formData.append('file', mergedFileBuffer, {
            filename: fileName,
            contentType: 'application/octet-stream',
          });
          formData.append('mid', sender.mid);
          formData.append('uid', sender.userid);
          formData.append('role', sender.role);
          formData.append('name', sender.name);
          formData.append('type', sender.type);
          formData.append('room', room);

          // Append optional fields if provided
          if (sender.replyto) formData.append('replyto', sender.replyto);
          if (sender.replytoId) formData.append('replytoId', sender.replytoId);
          if (sender.replytochattype) formData.append('replytochattype', sender.replytochattype);
          if (sender.replytousertype) formData.append('replytousertype', sender.replytousertype);

          // Upload merged file
          const response = await axios.post('https://api.nollywoodfilmmaker.com/api/chat/upload', formData, {
            headers: {
              ...formData.getHeaders(),
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          });

          console.log('Merged file uploaded:', response.data);

          // Emit the file message to the room
          io.to(room).emit('fileMessage', {
            sender,
            fileName,
            fileUrl: response.data.file.path,
            replyto: sender.replyto || null,
            replytoId: sender.replytoId || null,
            replytousertype: sender.replytousertype || null,
            replytochattype: sender.replytochattype || null,
            timestamp: response.data.file.timestamp,
          });

          // Clean up the merged file and the tracking object
          fs.unlinkSync(mergedFilePath);
          delete fileUploads[uploadId];
        } catch (error) {
          console.error(`Error merging/uploading file for upload ${uploadId}:`, error);
          io.to(room).emit('error', { message: 'Failed to merge and upload file chunks' });
        }
      }
    }
  );

  // Existing file sharing event (if needed)
  socket.on('sendFile', async ({ room, fileName, fileData, sender }) => {
    try {
      // Reject executable files
      const fileExt = path.extname(fileName || '').toLowerCase();
      if (fileExt === '.exe') {
        io.to(room).emit('error', { message: 'Executable files (.exe) are not allowed' });
        return;
      }

      // Convert fileData from Base64 to Buffer if needed
      if (typeof fileData === 'string') {
        const base64Data = fileData.split(',')[1]; // Remove DataURL prefix if present
        fileData = Buffer.from(base64Data, 'base64');
      }

      if (!(fileData instanceof Buffer)) {
        console.error('fileData must be a Buffer');
        io.to(room).emit('error', { message: 'File data format is incorrect' });
        return;
      }

      // Prepare form data for upload
      const formData = new FormData();
      formData.append('file', fileData, {
        filename: fileName || 'uploadedFile',
        contentType: 'application/octet-stream',
      });
      formData.append('mid', sender.mid);
      formData.append('uid', sender.userid);
      formData.append('role', sender.role);
      formData.append('name', sender.name);
      formData.append('type', sender.type);
      formData.append('room', room);

      if (sender.replyto) formData.append('replyto', sender.replyto);
      if (sender.replytoId) formData.append('replytoId', sender.replytoId);
      if (sender.replytochattype) formData.append('replytochattype', sender.replytochattype);
      if (sender.replytousertype) formData.append('replytousertype', sender.replytousertype);

      console.log(formData);

      // Upload file
      const response = await axios.post('https://api.nollywoodfilmmaker.com/api/chat/upload', formData, {
        headers: {
          ...formData.getHeaders(),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      });

      console.log(response);

      // Emit file message after successful upload
      io.to(room).emit('fileMessage', {
        sender,
        fileName,
        fileUrl: response.data.file.path,
        replyto: sender.replyto || null,
        replytoId: sender.replytoId || null,
        replytousertype: sender.replytousertype || null,
        replytochattype: sender.replytochattype || null,
        timestamp: response.data.file.timestamp,
      });

      console.log(response.data.file.path);
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
