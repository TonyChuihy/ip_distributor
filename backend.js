const WebSocket = require("ws");
const os = require("os");
const { stat } = require("fs");

const MACHINE_UID = "test-node-1"; // Uid of this machine, should be same with backend.json
// 获取本机IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}

const backendConfig = {
  //應與backend.json內容相同
  ip: getLocalIP(),
  queryPort: "localhost:3001", // 负载均衡器查询端口，應對於所有機器相同
  workPort: 4000, // 工作API端口
  services: ["chatgpt", "stable-diffusion", "llama"], // 此項暫時沒有應用
};

// 工作接口服务器
const wssWork = new WebSocket.Server({ port: backendConfig.workPort });
let currentClient = null;
let workTimer = null;

console.log(
  `[Backend] 工作API运行在 ws://${backendConfig.ip}:${backendConfig.workPort}`
);

// 处理工作接口连接
wssWork.on("connection", (wsClient) => {
  if (currentClient) {
    console.log("[Backend] 拒绝新连接: 已有客户端");
    wsClient.close();
    return;
  }

  console.log("[Backend] 客户端连接工作接口");
  currentClient = wsClient;

  // 通知负载均衡器状态更新
  notifyLoadBalancer("busy");

  // 设置工作完成定时器
  workTimer = setInterval(() => {
    if (wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(
        JSON.stringify({
          type: "work_done",

          message: "工作已完成",
        })
      );
      console.log("[Backend] 发送工作完成通知到client");
    }
  }, 5000);

  // 处理客户端断开
  wsClient.on("close", () => {
    console.log("[Backend] 客户端断开工作接口");
    cleanupWorkConnection();
  });
});

// 清理工作连接
function cleanupWorkConnection() {
  if (workTimer) {
    clearInterval(workTimer);
    workTimer = null;
  }

  currentClient = null;

  // 通知负载均衡器状态更新
  notifyLoadBalancer("idle");
}

// 连接负载均衡器
const wsLB = new WebSocket(`ws://${backendConfig.queryPort}`);

wsLB.on("open", () => {
  console.log("[Backend] 连接到负载均衡器");
  const status = currentClient === null ? "idle" : "busy";
  // 注册后端
  wsLB.send(
    JSON.stringify({
      type: "register",
      uid: MACHINE_UID,
      ip: backendConfig.ip,
      queryPort: backendConfig.queryPort,
      workPort: backendConfig.workPort,
      services: backendConfig.services,
      status: status,
    })
  );
});

// 处理负载均衡器消息
wsLB.on("message", (data) => {
  const message = JSON.parse(data);
  if (message.type === "registered") {
    console.log(`[Backend] 注册成功，ID: ${MACHINE_UID}`);
  }
});

// 通知负载均衡器状态变化
function notifyLoadBalancer(status) {
  if (wsLB.readyState === WebSocket.OPEN) {
    wsLB.send(
      JSON.stringify({
        type: "status_update",
        uid: MACHINE_UID,
        status: status,
      })
    );
    console.log(`[Backend] 状态更新: ${status}`);
  }
}

// 处理关闭
wsLB.on("close", () => console.log("[Backend] 断开负载均衡器连接"));
wssWork.on("close", () => console.log("[Backend] 工作服务器关闭"));

console.log("后端服务启动，等待连接...");
