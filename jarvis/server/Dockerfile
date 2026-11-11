# JARVIS 云端镜像：一个容器 = 页面 + 大模型代理 + 搜索/地图/城市数据 + 记忆同步
# 构建上下文必须是仓库根：docker build -f jarvis/server/Dockerfile -t jarvis-cloud .
FROM node:22-alpine
WORKDIR /app

# 页面与静态资源（含本地 MediaPipe 资源，手机/眼镜手势可用）
COPY JARVIS-HUD.html /app/JARVIS-HUD.html
COPY JARVIS-手势版.html /app/JARVIS-手势版.html
COPY jarvis/index.html /app/jarvis/index.html
COPY jarvis/app.css /app/app.css
COPY jarvis/vendor/ /app/jarvis/vendor/
COPY jarvis/js/ /app/jarvis/js/
COPY jarvis/plugins/ /app/jarvis/plugins/

# 云服务 + MVT 解析依赖（城市真实数据）
COPY jarvis/server/cloud-server.mjs /app/server/cloud-server.mjs
COPY jarvis/server/vendor_node/ /app/server/vendor_node/
COPY jarvis/server/manifest.json /app/manifest.json
COPY jarvis/server/icon-180.png /app/icon-180.png
COPY jarvis/server/icon-512.png /app/icon-512.png

ENV PORT=8890 PUBLIC_DIR=/app NODE_ENV=production
EXPOSE 8890
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD wget -qO- http://127.0.0.1:8890/api/health >/dev/null 2>&1 || exit 1
CMD ["node", "/app/server/cloud-server.mjs"]
