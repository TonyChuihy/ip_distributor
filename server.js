const WebSocket = require("ws");
const fs = require("fs");
const wssClients = new WebSocket.Server({ port: 3000 });
const wssBackends = new WebSocket.Server({ port: 3001 });

const config_file = require("./backend.json");
const backendPool = new Map();
const clientQueue = [];

// 处理客户端连接
wssClients.on("connection", (wsClient) => {
  console.log("[LB] 客户端连接");

  // 查找空闲后端
  const availableBackend = [...backendPool.entries()].find(
    ([Machine_UID, backend]) => backend.status === "idle"
  );

  if (availableBackend) {
    // 分配空闲后端
    const [Machine_UID, backendInfo] = availableBackend;
    assignBackendToClient(wsClient, Machine_UID, backendInfo);
  } else {
    // 加入等待队列
    const queuePosition = clientQueue.length + 1;
    clientQueue.push(wsClient);
    wsClient.send(
      JSON.stringify({
        type: "queued",
        position: queuePosition,
      })
    );
    console.log(`[LB] 客户端加入队列，位置: ${queuePosition}`);
  }

  // 处理客户端断开
  wsClient.on("close", () => {
    const index = clientQueue.indexOf(wsClient);
    if (index !== -1) {
      clientQueue.splice(index, 1);
      updateQueuePositions();
    }
    console.log("[LB] 客户端断开");
  });
});

// 处理后端连接
wssBackends.on("connection", (wsBackend) => {
  console.log("[LB] 后端连接");

  // 初始化后端状态
  wsBackend.on("message", (message) => {
    const messageObj = JSON.parse(message);
    const Machine_UID = JSON.parse(message).uid;
    const data = config_file.genai_backends.find(
      (backend) => backend.uid === Machine_UID
    );
    if (!data) {
      console.error("[LB] 未找到后端配置");
      return;
    }

    if (messageObj.type === "register") {
      // 后端注册

      backendPool.set(Machine_UID, {
        connection: wsBackend,
        id: Machine_UID,
        ip: data.ip,
        queryPort: data.queryPort,
        workPort: data.workPort,
        services: data.services,
        status: messageObj.status,
      });

      console.log(
        `[LB] 后端注册: ${Machine_UID} (${data.ip}:${data.workPort}) ${messageObj.status}`
      );
      wsBackend.send(
        JSON.stringify({
          type: "registered",
          id: Machine_UID,
        })
      );
      // 尝试分配任务
      assignBackendToNextClient();
    } else if (messageObj.type === "status_update") {
      // 状态更新
      console.log(
        `[LB] Pool存在后端: ${Machine_UID}：${backendPool.has(Machine_UID)}`
      );
      if (backendPool.has(Machine_UID)) {
        backendPool.set(Machine_UID, {
          ...backendPool.get(Machine_UID),
          status: messageObj.status,
        });

        console.log(
          `[LB] 后端状态更新: ${Machine_UID} -> ${messageObj.status}`
        );

        // 如果变为空闲，尝试分配任务
        if (messageObj.status === "idle") {
          assignBackendToNextClient();
        }
      }
    }
  });

  // 处理后端断开
  wsBackend.on("close", () => {
    // 查找并移除断开的后端
    for (const [id, backend] of backendPool.entries()) {
      if (backend.connection === wsBackend) {
        backendPool.delete(id);
        console.log(`[LB] 后端断开: ${id}`);
        break;
      }
    }
  });
});

// 分配后端给客户端
function assignBackendToClient(wsClient, Machine_UID, backendInfo) {
  if (wsClient.readyState === WebSocket.OPEN) {
    backendPool.set(Machine_UID, {
      ...backendInfo,
      status: "busy",
    });

    wsClient.send(
      JSON.stringify({
        type: "assigned",
        backend: {
          id: Machine_UID,
          ip: backendInfo.ip,
          workPort: backendInfo.workPort,
        },
      })
    );
    wsClient.close(); // 关闭客户端连接到负载均衡器

    console.log(`[LB] 分配后端 ${Machine_UID} 给客户端`);
  }
}

// 分配后端给下一个等待的客户端
function assignBackendToNextClient() {
  if (clientQueue.length > 0) {
    const wsClient = clientQueue.shift();
    const availableBackend = [...backendPool.entries()].find(
      ([, backend]) => backend.status === "idle"
    );

    if (availableBackend) {
      const [Machine_UID, backendInfo] = availableBackend;
      assignBackendToClient(wsClient, Machine_UID, backendInfo);
    } else {
      // 没有空闲后端，放回队列
      clientQueue.unshift(wsClient);
    }

    updateQueuePositions();
  }
}

// 更新队列位置
function updateQueuePositions() {
  clientQueue.forEach((client, index) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(
        JSON.stringify({
          type: "queue_update",
          position: index + 1,
        })
      );
    }
  });
}

console.log("负载均衡器运行中:");
console.log("客户端端口: ws://localhost:3000");
console.log("后端端口: ws://localhost:3001");
