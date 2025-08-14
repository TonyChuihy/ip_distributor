首先npm install
然後依次 node server.js
node backend.js

此時模擬後端和lb已經啓動

node client.js模擬前端鏈接。可以多開terminal模擬多個前端

如果想模擬多個後端，需要修改backend.json和創建backend2.js，其中需要保持兩個文檔中的設定相同

工作流程：
sequenceDiagram
    participant Client
    participant LoadBalancer
    participant Backend
    
    Client->>LoadBalancer: 请求后端分配
    alt 有空闲后端
        LoadBalancer->>Client: 返回后端地址
        Client->>Backend: 连接工作接口
        Backend->>LoadBalancer: 更新状态(忙碌)
        Backend->>Client: 每5秒发送"工作已完成"
        Client->>Backend: 收到通知后断开
        Backend->>LoadBalancer: 更新状态(空闲)
    else 无空闲后端
        LoadBalancer->>Client: 返回排队位置
        loop 等待空闲后端
            LoadBalancer->>LoadBalancer: 检查后端状态
            Backend->>LoadBalancer: 状态更新(空闲)
            LoadBalancer->>Client: 分配后端地址
        end
    end
