const WebSocket = require("ws");
const fs = require("fs");
const wssClients = new WebSocket.Server({ port: 3000 });
const wssBackends = new WebSocket.Server({ port: 3001 });

const config_file = require("./backend.json");
const e = require("express");
const backendPool = new Map();
const clientQueue = [];

// 处理客户端连接
wssClients.on("connection", (wsClient) => {
  console.log("[LB] 客户端连接");
  let clientNeeds = ""; // 存储客户端需要的服务类型

  wsClient.on("message", (message) => {
    try {
      const messageObj = JSON.parse(message);
      if (messageObj.type === "register") {
        // 客户端注册
        clientNeeds = messageObj.service;
        console.log(`[LB] 客户端请求服务: ${clientNeeds}`);
        const availableBackend = findAvailableBackend(clientNeeds);
        if (availableBackend) {
          // 分配空闲后端
          const [Machine_UID, backendInfo] = availableBackend;
          assignBackendToClient(wsClient, Machine_UID, backendInfo);
        } else {
          // 加入等待队列，包含所需服务信息
          const queuePosition = clientQueue.length + 1;
          clientQueue.push({
            ws: wsClient,
            needs: clientNeeds,
          });

          wsClient.send(
            JSON.stringify({
              type: "queued",
              position: queuePosition,
            })
          );
          console.log(
            `[LB] 客户端加入队列，位置: ${queuePosition}, 需要服务: ${clientNeeds}`
          );
          FindSwapableBackend();
        }
      }
    } catch (e) {
      console.error("[LB] 解析客户端消息错误:", e);
    }
  });

  // 处理客户端断开
  wsClient.on("close", () => {
    const index = clientQueue.findIndex((item) => item.ws === wsClient);
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

  wsBackend.on("message", (message) => {
    try {
      const messageObj = JSON.parse(message);
      const Machine_UID = messageObj.uid;
      const data = config_file.genai_backends.find(
        (backend) => backend.uid === Machine_UID
      );

      if (!data) {
        console.error("[LB] 未找到后端配置");
        return;
      }

      if (messageObj.type === "register") {
        // 后端注册
        if (data.enabled === false) {
          console.log(`[LB] 后端 ${Machine_UID} 未启用，忽略注册`);
          return wsBackend.close();
        }

        backendPool.set(Machine_UID, {
          connection: wsBackend,
          uid: Machine_UID,
          ip: data.ip,
          queryPort: data.queryPort,
          workPort: data.workPort,
          services: data.available_services, // 后端支持的所有服务
          status: messageObj.status,
          currentServices: messageObj.currentServices || [], // 当前正在运行的服务
          swapable: true,
          swap_cd: data.swap_cd,
          swap_timer: null,
          ws_holded_client: null,
        });

        console.log(
          `[LB] 后端注册: ${Machine_UID} (${data.ip}:${data.workPort}) ` +
            `状态: ${messageObj.status} ` +
            `支持服务: ${data.available_services.join(", ")} ` +
            `当前服务: ${
              messageObj.currentServices
                ? messageObj.currentServices.join(", ")
                : "无"
            }`
        );

        wsBackend.send(
          JSON.stringify({
            type: "registered",
            uid: Machine_UID,
          })
        );

        // 尝试分配任务
        assignBackendAndClientOnPoolQuene();
      } else if (messageObj.type === "status_update") {
        // 状态更新
        if (backendPool.has(Machine_UID)) {
          const backend = backendPool.get(Machine_UID);
          backendPool.set(Machine_UID, {
            ...backend,
            status: messageObj.status,
            currentServices: messageObj.currentServices || [],
          });
          if (messageObj.status === "busy") {
            backendPool.get(Machine_UID).swapable = false;
            clearTimeout(backendPool.get(Machine_UID).swap_timer);
          }

          console.log(
            `[LB] 后端状态更新: ${Machine_UID} -> ${messageObj.status} ` +
              `当前服务: ${messageObj.currentServices?.join(", ") || "无"}`
          );

          // 如果变为空闲，尝试分配任务
          if (messageObj.status === "idle") {
            backendPool.get(Machine_UID).status = "idle";
            isAssigned = assignBackendAndClientOnPoolQuene();
            if (!isAssigned) {
              console.log(
                `[LB] 后端 ${Machine_UID} ${
                  backendPool.get(Machine_UID).status
                }，无可分配任务`
              );
              backendPool.set(Machine_UID, {
                ...backendPool.get(Machine_UID),
                swap_timer: setTimeout(() => {
                  console.log(
                    `[LB] 后端 ${Machine_UID} 計時器⏲完畢：${
                      backendPool.get(Machine_UID).status
                    }`
                  );
                  if (backendPool.get(Machine_UID).status === "idle") {
                    console.log(`[LB] 后端 ${Machine_UID} 可交换`);

                    backendPool.set(Machine_UID, {
                      ...backendPool.get(Machine_UID),
                      swapable: true,
                      swap_timer: null,
                    });
                  }
                  FindSwapableBackend();
                }, data.swap_cd * 1000),
              });
            }
          }
        }
      } else if (messageObj.type === "swpped") {
        // 处理交换请求
        const client = backendPool.get(Machine_UID).ws_holded_client;
        // backendPool.get(Machine_UID).ws_holded_client = null;
        backendPool.get(Machine_UID).currentServices =
          messageObj.currentServices;
        assignBackendToClient(
          client,
          Machine_UID,
          backendPool.get(Machine_UID)
        );
      }
    } catch (e) {
      console.error("[LB] 解析后端消息错误:", e);
    }
  });

  // 处理后端断开
  wsBackend.on("close", () => {
    for (const [uid, backend] of backendPool.entries()) {
      if (backend.connection === wsBackend) {
        clearTimeout(backendPool.get(Machine_UID).swap_timer);
        backendPool.delete(uid);
        console.log(`[LB] 后端断开: ${uid}`);
        break;
      }
    }
  });
});

// 查找提供所需服务的空闲后端
const findAvailableBackend = (clientNeeds) => {
  console.log(`[LB] 查找提供服务 ${clientNeeds} 的空闲后端`);
  return [...backendPool.entries()].find(([Machine_UID, backend]) => {
    // 检查后端状态是否空闲且提供所需服务
    const isIdle = backend.status === "idle";
    const providesService = backend.currentServices.includes(clientNeeds);
    console.log(
      `[LB] 检查后端 ${Machine_UID} 状态: isIdle=${isIdle}, providesService=${providesService}`
    );
    return isIdle && providesService;
  });
};

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
          uid: Machine_UID,
          ip: backendInfo.ip,
          workPort: backendInfo.workPort,
          services: backendInfo.services, // 可选：告诉客户端后端支持的服务
        },
      })
    );
    wsClient.close(); // 关闭客户端连接到负载均衡器

    console.log(`[LB] 分配后端 ${Machine_UID} 给客户端`);
  }
}

// 根據已有的客戶隊伍和後端池分配下一個後端，return isAssigned,不執行swapping
function assignBackendAndClientOnPoolQuene() {
  if (clientQueue.length === 0) return false;

  // 查找可以满足需求的空闲后端
  for (let i = 0; i < clientQueue.length; i++) {
    const { ws: wsClient, needs } = clientQueue[i];
    const clientNeeds = needs;

    const availableBackend = findAvailableBackend(clientNeeds);

    if (availableBackend) {
      // 找到合适的后端，从队列中移除并分配
      clientQueue.splice(i, 1);
      const [Machine_UID, backendInfo] = availableBackend;
      assignBackendToClient(wsClient, Machine_UID, backendInfo);
      updateQueuePositions();
      return true;
    }

    // // 未找到合适的后端，嘗試swapping
    // const swappableBackend = [...backendPool.entries()].find(([_, backend]) => {
    //   const isIdle = backend.status === "idle" ;
    //   const providesService =
    return false;
  }
}
function FindSwapableBackend() {
  for (let i = 0; i < clientQueue.length; i++) {
    const { ws: wsClient, needs } = clientQueue[i];
    const clientNeeds = needs;

    const [uid, swappableBackend] = [...backendPool.entries()].find(
      ([_, backend]) => {
        const isIdleandSwapable = backend.status === "idle" && backend.swapable;
        const providesService = backend.services.includes(clientNeeds);
        console.log(
          `[LB] 检查后端 ${backend.uid} 状态， 是否交換: ${
            isIdleandSwapable && providesService
          }`
        );
        return isIdleandSwapable && providesService;
      }
    );
    if (swappableBackend) {
      console.log(
        `[LB] 要求轉換後端: ${swappableBackend.uid} -> ${clientNeeds} `
      );
      swappableBackend.connection.send(
        JSON.stringify({
          type: "swap_request",
          service: clientNeeds,
        })
      );
      swappableBackend.ws_holded_client = wsClient;
      // clientQueue.splice(i, 1);
    }
  }
}
// 更新队列位置
function updateQueuePositions() {
  clientQueue.forEach((item, index) => {
    if (item.ws.readyState === WebSocket.OPEN) {
      item.ws.send(
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
