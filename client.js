const WebSocket = require("ws");

// 客户端配置
const clientConfig = {
  lbAddress: "ws://localhost:3000",
  serviceType: "chatgpt",
};

let backendConnection = null;
const clientId = `client_${Math.random().toString(36).substr(2, 6)}`;

console.log(`[Client ${clientId}] 启动，请求服务: ${clientConfig.serviceType}`);

// 连接负载均衡器
const wsLB = new WebSocket(clientConfig.lbAddress);

wsLB.on("open", () => {
  console.log(`[Client ${clientId}] 连接负载均衡器`);
});

wsLB.on("message", (data) => {
  const message = JSON.parse(data);

  if (message.type === "assigned") {
    console.log(`[Client ${clientId}] 分配到后端: ${message.backend.id}`);
    connectToBackend(message.backend);
  } else if (message.type === "queued") {
    console.log(`[Client ${clientId}] 排队中，位置: ${message.position}`);
  } else if (message.type === "queue_update") {
    console.log(`[Client ${clientId}] 队列位置更新: ${message.position}`);
  }
});

wsLB.on("close", () => {
  console.log(`[Client ${clientId}] 断开负载均衡器连接`);
});

// 连接后端工作接口
function connectToBackend(backendInfo) {
  const backendAddress = `ws://${backendInfo.ip}:${backendInfo.workPort}`;
  console.log(`[Client ${clientId}] 连接后端: ${backendAddress}`);

  backendConnection = new WebSocket(backendAddress);

  backendConnection.on("open", () => {
    console.log(`[Client ${clientId}] 已连接后端工作接口`);
    // wsLB.close(); // 关闭负载均衡器连接
  });

  backendConnection.on("message", (data) => {
    const message = JSON.parse(data);

    if (message.type === "work_done") {
      console.log(`[Client ${clientId}] 收到工作完成通知: ${message.message}`);
      console.log(`[Client ${clientId}] 断开后端连接`);
      backendConnection.close();
    }
  });

  backendConnection.on("close", () => {
    console.log(`[Client ${clientId}] 断开后端连接`);
    backendConnection = null;
  });

  backendConnection.on("error", (err) => {
    console.error(`[Client ${clientId}] 后端连接错误: ${err.message}`);
  });
}
