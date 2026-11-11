/* ============================================================================
 * JARVIS 2.0 · 08-boot.js
 * 状态机与编排：启动、意图路由、场景切换、任务进度、快捷键、手势/语音联动
 * 依赖：JV + 04-hud + 05-voice + 06-gesture + 07-agent + 场景模块
 * ==========================================================================*/
(function () {
  'use strict';
  var JV = window.JV;
  var U = JV.util;
  var bus = JV.bus;
  var hud = null;
  var booted = false;
  var busy = false;

  var LS_SEEN = 'jarvis2.seen.v1';

  /* ------------------------------------------------------ 内置离线回复（兜底） */
  function offlineRoute(text) {
    var t = String(text || '').toLowerCase();
    var has = function () { return Array.prototype.some.call(arguments, function (k) { return t.indexOf(k) >= 0; }); };
    if (has('天气', '气温', '下雨', 'weather')) {
      return {
        intent: 'weather',
        reply: '现在 15 度，阴，先生。明天白天 19 度，适合出门。',
        replyEn: 'It is 15 degrees and overcast now, sir. Tomorrow peaks at 19.'
      };
    }
    if (has('大唐', '不夜城', '城市', '沙盘')) {
      return {
        intent: 'city',
        reply: '这是大唐不夜城的立体城市视图，先生。',
        replyEn: 'The three-dimensional city view of Datang City that Never Sleeps, sir.'
      };
    }
    if (has('设备', '电视', '灯', '风扇', '音箱', '净化器', '烘干')) {
      return {
        intent: 'device',
        reply: '我能控制九台设备，先生：两台电视（共三台）、两台空气净化器、烘干架、风扇、音箱和台灯。',
        replyEn: 'Nine devices in total, sir: two TVs offline, two air purifiers, drying rack, fan, speaker and desk lamp.'
      };
    }
    if (has('关掉', '关闭', '关灯', '熄灯')) {
      return {
        intent: 'device',
        reply: '晾衣架的灯已经关了，先生。',
        replyEn: "The drying rack's light is off now, sir."
      };
    }
    if (has('安排', '日程', '今天', 'schedule')) {
      return {
        intent: 'schedule',
        reply: '今天还没有安排，先生。您说，我来记。',
        replyEn: 'Nothing scheduled today, sir. Tell me what you need.'
      };
    }
    if (has('总结', '进展', '工作', 'summary')) {
      return {
        intent: 'summary',
        reply: '今天完成了 3 项：检索、构建、复核，先生。全部归零，随时可继续。',
        replyEn: 'Three tasks completed today, sir: search, build and verify.'
      };
    }
    if (has('好梦', '晚安', '关', 'sleep', 'shut')) {
      return {
        intent: 'off',
        reply: '好梦，先生。我在这儿。',
        replyEn: 'Good night, Jarvis.'
      };
    }
    if (has('你好', '嗨', 'hello', 'hi', '贾维斯')) {
      return {
        intent: 'orb',
        reply: '我在，先生。',
        replyEn: 'I am here, sir.'
      };
    }
    if (has('退出', '回去', '主界面', '返回')) {
      return { intent: 'orb', reply: '回到能量核心，先生。', replyEn: 'Back to the core, sir.' };
    }
    return {
      intent: 'chat',
      reply: '我在听，先生。要不要我查一下天气、路况，或者今天的安排？',
      replyEn: 'I am listening, sir. Weather, traffic or today\u2019s schedule?'
    };
  }

  /* ------------------------------------------------------------- 任务进度 */
  var progress = { done: 0, total: 0, timer: 0 };
  function resetTasks(total) {
    progress.done = 0;
    progress.total = total || 0;
    hud.setTaskProgress(progress.done, progress.total);
    ['search', 'build', 'verify'].forEach(function (t) { hud.setTaskStatus(t, 'idle'); });
  }
  function runTaskChain() {
    var chain = ['search', 'build', 'verify'];
    var total = chain.length;
    progress.total = total;
    hud.setTaskProgress(0, total);
    chain.forEach(function (t, i) {
      setTimeout(function () {
        hud.setTaskStatus(t, 'start');
        setTimeout(function () {
          hud.setTaskStatus(t, 'ok');
          progress.done = i + 1;
          hud.setTaskProgress(progress.done, progress.total);
          if (progress.done === total) {
            setTimeout(function () {
              chain.forEach(function (x) { hud.setTaskStatus(x, 'done'); });
            }, 900);
          }
        }, 420 + i * 160);
      }, i * 520);
    });
  }

  /* --------------------------------------------------------------- 场景切换 */
  function setOrbMode(mode) {
    var orb = JV.scenes.orb && JV.scenes.orb.entity;
    if (orb && orb.setMode) orb.setMode(mode);
    JV.state.mode = mode;
    hud && hud.setMicState(mode === 'think' ? 'think' : mode === 'speak' ? 'speak' : mode === 'listen' ? 'listen' : 'idle');
  }

  var SCENES = {
    orb: function () {
      JV.show('orb');
      setOrbMode('idle');
      hud.setSubtitle({ who: 'jarvis', zh: '能量核心已就绪，先生。', en: 'Core online, sir.', done: true });
    },
    city: function (opts) {
      var ent = JV.show('city');
      if (ent) {
        if (ent.setMode) ent.setMode((opts && opts.mode) || 'build');
        setTimeout(function () { if (ent.setMode) ent.setMode('orbit'); }, 1200);
      }
      if (!opts || !opts.silent) {
        hud.setSubtitle({ who: 'jarvis', zh: '这是大唐不夜城的实时立体城市，先生。', en: 'Datang City that Never Sleeps, sir.', done: true });
      }
    },
    globe: function (opts) {
      var ent = JV.show('globe');
      if (ent) {
        ent.setMode('earth');
        var city = (opts && opts.city) || '';
        if (city) {
          hud.setSubtitle({ who: 'jarvis', zh: '正在调取 ' + city + ' 的全息城市数据，先生。', en: 'Pulling the holographic city data for ' + city + ', sir.', done: true });
          setTimeout(function () {
            ent.focus(city).then(function (r) {
              if (r && r.ok) hud.toast('已加载：' + city + ' · 真实街道全息', 3000);
              else hud.toast('地图数据不可达，显示示意城市', 3000);
            });
          }, 260);
        } else {
          hud.setSubtitle({ who: 'jarvis', zh: '全球城市全息已就绪，先生。想看哪座城市？', en: 'Global city hologram ready, sir. Which city?', done: true });
        }
      }
    },
    warp: function () {
      JV.show('orb');
      setOrbMode('warp');
      setTimeout(function () { setOrbMode('idle'); }, 2600);
    },
    off: function (opts) {
      JV.show('orb');
      setOrbMode('shutdown');
      if (!opts || !opts.silent) {
        hud.setSubtitle({ who: 'jarvis', zh: '好梦，先生。我在这儿。', en: 'Good night, sir. I am here.', done: true });
      }
    }
  };

  function sceneKeys(n) {
    if (n === 1) SCENES.orb();
    else if (n === 2) SCENES.city({ mode: 'build' });
    else if (n === 3) SCENES.warp();
    else if (n === 4) { var e = JV.show('city'); if (e && e.setMode) e.setMode('green'); }
    else if (n === 5) SCENES.off();
    else if (n === 6) SCENES.globe({});
    else if (n === 7) SCENES.globe({ city: '东京' });
  }

  /* -------------------------------------------------------------- 一轮对话 */
  function handleTurn(text) {
    if (busy) return;
    if (!text) return;
    busy = true;
    JV.state.mode = 'think';
    setOrbMode('think');
    hud.setTaskStatus('search', 'start');
    progress.done = 0;
    hud.setTaskProgress(0, 0);

    // 工具调用后的收尾（复用同一套字幕/朗读/任务链/场景切换）
    var finishWithTool = function (name, args) {
      if (!JV.tools) { return Promise.resolve(null); }
      hud.setSubtitle({ who: 'jarvis', zh: '正在执行本机操作：' + name, en: 'Executing on this Mac: ' + name, done: false, animate: false });
      setOrbMode('think');
      var runner = (JV.plugins && JV.plugins.findTool && JV.plugins.findTool(name)) ? JV.plugins.run : JV.tools.run;
      return runner(name, args).then(function (res) {
        bus.emit('tool:done', { name: name, ok: res.ok, result: res.result });
        return agentSecondRound(res.result).then(function (p) { return p; });
      });
    };

    var agentSecondRound = function (toolResult) {
      var ag = JV.agent;
      var msg = '（本机工具返回）\n' + String(toolResult).slice(0, 3000) +
        '\n请用一句中文向先生汇报结果，英文附在后面；需要的话可追加一个意图标记，不要再调用工具。';
      if (!ag || typeof ag.send !== 'function') {
        return Promise.resolve({ text: String(toolResult), intent: 'orb' });
      }
      return ag.send(msg, {}).then(function (r) {
        var p = r || {};
        var zb = U.splitBilingual(p.text || '');
        return { text: zb.zh || p.text || String(toolResult), textEn: zb.en || p.textEn || '', intent: p.intent || 'orb' };
      }).catch(function () {
        return { text: String(toolResult).slice(0, 400), textEn: '', intent: 'orb' };
      });
    };

    var finish = function (reply, replyEn, intent, meta) {
      var zh = reply || '';
      var en = replyEn || '';
      hud.setSubtitle({ who: 'jarvis', zh: zh, en: en, done: true });
      hud.setTranscript({ text: text });
      if (JV.memory && !window.__jvReplyRecorded) JV.memory.addTurn('jarvis', zh);
      if (JV.voice && JV.settings.voice) JV.voice.speak(zh);
      runTaskChain();
      // 场景意图
      setTimeout(function () {
        if (intent === 'globe') SCENES.globe({ city: extractCity(text) });
        else if (intent === 'city') SCENES.city({ silent: true });
        else if (intent === 'device') {
          JV.show('city');
          var e = JV.scenes.city && JV.scenes.city.entity;
          if (e && e.setMode) e.setMode('green');
        } else if (intent === 'warp') SCENES.warp();
        else if (intent === 'off') SCENES.off({ silent: true });
        else if (intent === 'orb') { JV.show('orb'); setOrbMode('idle'); }
        else setOrbMode('speak');
      }, 60);
      setTimeout(function () {
        busy = false;
        if (JV.state.mode !== 'off') setOrbMode('idle');
      }, Math.min(9000, 1600 + zh.length * 120));
    };

    // 0) 记忆类指令（记住 / 清空 / 回忆）直接本地处理
    if (JV.memory && JV.memory.handleCommand) {
      var mc = JV.memory.handleCommand(text);
      if (mc && mc.handled) {
        finish(mc.reply, mc.replyEn, mc.intent || 'chat');
        busy = false;
        return;
      }
    }


    var agent = JV.agent;
    if (agent && typeof agent.send === 'function') {
      var settled = false;
      var settle = function () { if (!settled) { settled = true; busy = false; setOrbMode('idle'); } };
      var watchdog = setTimeout(function () { if (!settled) { var r = offlineRoute(text); finish(r.reply, r.replyEn, r.intent); } }, 14000);
      var onReply = function (p) {
        if (!p) return;
        if (p.streaming) {
          var zb = U.splitBilingual(p.text);
          hud.setSubtitle({ who: 'jarvis', zh: zb.zh, en: zb.en || '', done: false });
        }
      };
      bus.on('agent:reply', onReply);
      agent.send(text).then(function (r) {
        clearTimeout(watchdog);
        bus.off('agent:reply', onReply);
        var payload = r || {};
        if (payload.offline) {
          var local = offlineRoute(text);
          finish(local.reply, local.replyEn, local.intent || payload.intent);
        } else {
          var toolCall = JV.tools && JV.tools.parse ? JV.tools.parse(payload.raw || payload.text || '') : null;
          if (toolCall && JV.tools.isAvailable()) {
            finishWithTool(toolCall.name, toolCall.args).then(function (p2) {
              if (p2) finish(p2.text, p2.textEn, p2.intent);
              else finish('先生，本机权限桥没有接通。', 'The system bridge is not connected, sir.', payload.intent);
            });
          } else {
            var zb = U.splitBilingual(payload.text || '');
            finish(zb.zh || payload.text, zb.en || payload.textEn || '', payload.intent);
          }
        }
        settle();
      }).catch(function () {
        clearTimeout(watchdog);
        bus.off('agent:reply', onReply);
        var local = offlineRoute(text);
        finish(local.reply, local.replyEn, local.intent);
        settle();
      });
    } else {
      setTimeout(function () {
        var r = offlineRoute(text);
        finish(r.reply, r.replyEn, r.intent);
      }, 420);
    }
  }


  /* ------------------------------------------------------------ 全息缩放 */
  var ZOOM_MIN = 0.55, ZOOM_MAX = 2.6;
  function gestureReset() {
    GEST = { zoom: 1, rotY: 0, rotX: 0, panX: 0, panY: 0, roll: 0 };
    JV.state.rotY = 0; JV.state.rotX = 0; JV.state.panX = 0; JV.state.panY = 0; JV.state.roll = 0;
    JV.state.zoom = 1;
    if (hud) { hud.setZoom(1); hud.toast('手势已复位', 1400); }
  }
  function zoomReset() {
    JV.state.zoom = 1;
    if (hud) hud.setZoom(1);
    if (hud) hud.toast('缩放已复位 ×1.00', 1500);
  }
  function adjustZoom(delta) {
    var z = U.clamp((JV.state.zoom || 1) + delta, ZOOM_MIN, ZOOM_MAX);
    JV.state.zoom = z;
    if (hud) hud.setZoom(z);
    return z;
  }
  // 双手骨骼 → 旋转 / 缩放 / 平移（MediaPipe Hands 21 点，绝对目标值，不累加）
  function gestureLabel(mode) {
    var map = {
      'two-grab': '双手抓取 · 旋转/缩放', 'two-pinch': '双手捏合', 'one-open': '单手 · 旋转',
      'one-pinch': '单手捏合 · 缩放', 'one-move': '单手移动 · 旋转', idle: '待机'
    };
    return map[mode] || '手势';
  }
  bus.on('gesture:transform', function (p) {
    if (!p) { if (hud) hud.setGesture({ enabled: true, mode: '待机', count: 0 }); return; }
    if (p.idle) {
      if (hud) hud.setGesture({ enabled: true, mode: '待机（手势已锁定当前姿态）', count: 0 });
      return;
    }
    // 绝对目标：直接对齐到手势算出的目标姿态（可逆、不漂移、松手保持）
    JV.state.rotY = p.rotY;
    JV.state.rotX = p.rotX;
    JV.state.roll = p.roll;
    JV.state.zoom = p.zoom;
    JV.state.panX = p.panX;
    JV.state.panY = p.panY;
    if (hud) {
      hud.setZoom(p.zoom);
      hud.setGesture({ enabled: true, mode: gestureLabel(p.mode), count: p.hands || 1 });
    }
  });
  bus.on('gesture:zoom', function (p) {
    if (!p) return;
    var d = 0;
    if (p.mode === 'two-hand') d = (p.zoom || 0) * 2.6;      // 双手拉开/收拢
    else d = (p.zoom || 0) * 5.0 + (p.handZoom || 0) * 2.2;  // 捏合 / 手掌前后
    if (Math.abs(d) > 0.0008) adjustZoom(d);
  });
  // 鼠标拖拽旋转（无摄像头时的兜底手势）
  bus.on('pointer:drag', function (p) {
    if (!p) return;
    JV.state.rotY = U.clamp((JV.state.rotY || 0) + p.dx * 2.4, -12.56, 12.56);
    JV.state.rotX = U.clamp((JV.state.rotX || 0) + p.dy * 1.8, -1.15, 1.15);
    if (hud) hud.setGesture({ enabled: true, mode: '鼠标拖拽 · 旋转', count: 0 });
  });
  bus.on('pointer:wheel', function (p) {
    if (!p) return;
    adjustZoom(-p.delta * 0.0013);
  });

  /* ---------------------------------------------------- 从一句话里提取城市 */
  var CITY_ALIAS = {
    '北京': "Beijing",
    '上海': "Shanghai",
    '广州': "Guangzhou",
    '深圳': "Shenzhen",
    '成都': "Chengdu",
    '杭州': "Hangzhou",
    '西安': "Xi'an",
    '重庆': "Chongqing",
    '南京': "Nanjing",
    '武汉': "Wuhan",
    '苏州': "Suzhou",
    '天津': "Tianjin",
    '长沙': "Changsha",
    '郑州': "Zhengzhou",
    '青岛': "Qingdao",
    '厦门': "Xiamen",
    '昆明': "Kunming",
    '大连': "Dalian",
    '沈阳': "Shenyang",
    '哈尔滨': "Harbin",
    '长春': "Changchun",
    '济南': "Jinan",
    '合肥': "Hefei",
    '福州': "Fuzhou",
    '南昌': "Nanchang",
    '南宁': "Nanning",
    '贵阳': "Guiyang",
    '兰州': "Lanzhou",
    '西宁': "Xining",
    '银川': "Yinchuan",
    '乌鲁木齐': "Urumqi",
    '拉萨': "Lhasa",
    '呼和浩特': "Hohhot",
    '石家庄': "Shijiazhuang",
    '太原': "Taiyuan",
    '海口': "Haikou",
    '三亚': "Sanya",
    '无锡': "Wuxi",
    '宁波': "Ningbo",
    '温州': "Wenzhou",
    '佛山': "Foshan",
    '东莞': "Dongguan",
    '珠海': "Zhuhai",
    '中山': "Zhongshan",
    '惠州': "Huizhou",
    '泉州': "Quanzhou",
    '常州': "Changzhou",
    '南通': "Nantong",
    '徐州': "Xuzhou",
    '烟台': "Yantai",
    '淄博': "Zibo",
    '洛阳': "Luoyang",
    '开封': "Kaifeng",
    '桂林': "Guilin",
    '丽江': "Lijiang",
    '大理': "Dali",
    '敦煌': "Dunhuang",
    '张家界': "Zhangjiajie",
    '黄山': "Huangshan",
    '香港': "Hong Kong",
    '澳门': "Macau",
    '台北': "Taipei",
    '高雄': "Kaohsiung",
    '台中': "Taichung",
    '台南': "Tainan",
    '新北': "New Taipei",
    '桃园': "Taoyuan",
    '扬州': "Yangzhou",
    '绍兴': "Shaoxing",
    '嘉兴': "Jiaxing",
    '汕头': "Shantou",
    '湛江': "Zhanjiang",
    '桂林市': "Guilin",
    '遵义': "Zunyi",
    '绵阳': "Mianyang",
    '宜昌': "Yichang",
    '襄阳': "Xiangyang",
    '赣州': "Ganzhou",
    '九江': "Jiujiang",
    '芜湖': "Wuhu",
    '蚌埠': "Bengbu",
    '唐山': "Tangshan",
    '保定': "Baoding",
    '廊坊': "Langfang",
    '秦皇岛': "Qinhuangdao",
    '大同': "Datong",
    '包头': "Baotou",
    '鄂尔多斯': "Ordos",
    '大庆': "Daqing"
  };

  function extractCity(text) {
    var t = String(text || '');
    var keys = Object.keys(CITY_ALIAS);
    for (var i = 0; i < keys.length; i++) { if (t.indexOf(keys[i]) >= 0) return keys[i]; }
    // 英文城市名（取第一个首字母大写的长词，避开常见指令词）
    var m = t.match(/\b([A-Z][a-z]{3,}(?:\s[A-Z][a-z]+)?)\b/);
    if (m && !/^(Jarvis|Hello|What|Show|Open|Play|Please)$/i.test(m[1])) return m[1];
    return '';
  }

  /* ---------------------------------------------------------- 复刻模式 */
  // 按原片时间轴（76.6s）复放：创作者旁白字幕（A 层）+ HUD 内嵌字幕（B 层）+ 场景切换
  var DEMO = [
    { t: 0.2, scene: 'orb', mode: 'powerOn' },
    { t: 1.2, narr: { zh: '兄弟们贾维斯2.0已经正式上线', en: 'Brothers, Jarvis 2.0 is officially launched' } },
    { t: 4.2, narr: { zh: '他已经融入到我的生活当中了', en: 'He has been integrated into my life' } },
    { t: 6.0, mode: 'speak' },
    { t: 15.0, scene: 'city', mode: 'orbit', hud: {
      zh: '这是大唐不夜城的立体城市视图，先生。',
      en: 'The three-dimensional city view of Datang City that Never Sleeps, sir.' } },
    { t: 28.0, mode: 'green' },
    { t: 31.0, narr: { zh: '他给我导的航也是立体的城市', en: 'The walk he guided me was also a three-dimensional city' } },
    { t: 35.4, narr: { zh: '我家有多少个你能控制的设备', en: 'How many devices do you have in my house that you can control?' } },
    { t: 36.2, hud: { zh: '先生，我能控制的设备共有九台：两台目前离线的电视（电视共三台）、两台空气净化器、以及晾衣架、风扇、音箱和台灯。', en: 'You have nine devices I can control, sir: two TVs that are currently offline, three televisions in total, two air purifiers, the drying rack, the fan, the speaker and the desk lamp.' } },
    { t: 39.2, narr: { zh: '请帮我打开阳台晾衣架的灯光', en: 'Please help me turn on the light of the drying rack on the balcony.' } },
    { t: 46.2, hud: { zh: '先生，晾衣架的灯已经打开了。', en: "The drying rack's light is on now, sir." } },
    { t: 50.2, narr: { zh: '他真的现在已经融入到我的生活当中了', en: "He's really integrated into my life now" } },
    { t: 52.2, hud: { zh: '先生，晾衣架的灯已经关掉了。', en: "The drying rack's light is off now, sir." } },
    { t: 53.2, narr: { zh: '我知道现在有很多智能体都可以做到这样的效果', en: 'I know there are a lot of agents out there that can achieve such an effect' } },
    { t: 55.2, hud: { zh: '先生，能帮上忙我很高兴；晾衣架的灯是先留着，还是睡前帮您关掉？', en: "I'm glad to be of use, sir. Shall I leave the drying rack's light on, or turn it off before you retire?" } },
    { t: 56.2, narr: { zh: '但是贾维斯是我自己的', en: 'But Jarvis is my own' } },
    { t: 59.2, narr: { zh: '虽然我现在用的是投影仪', en: "I'm using a projector, though." } },
    { t: 61.2, narr: { zh: '但是我相信全息投影来的那一天', en: 'But I believe in the day the holographic projection comes' } },
    { t: 63.4, narr: { zh: '他就是真正的贾维斯', en: 'He is the real Jarvis' } },
    { t: 65.2, narr: { zh: '帮我把晾衣架灯光关了吧', en: 'Help me turn off the light of the drying rack.' } },
    { t: 68.0, scene: 'orb', mode: 'warp' },
    { t: 71.2, you: 'good night Javier' },
    { t: 73.0, hud: { zh: '先生，晾衣架的灯已经关掉了。', en: "The drying rack's light is off now, sir." } },
    { t: 74.4, mode: 'shutdown', hud: { zh: '好梦，先生。我在这儿。', en: 'Good night, sir. I am here.' } }
  ];
  var demo = { on: false, timers: [], t0: 0 };
  var narrEl = null;
  function narr(zh, en) {
    if (!narrEl) narrEl = document.getElementById('jv-narration');
    if (!narrEl) return;
    narrEl.querySelector('.zh').textContent = zh || '';
    narrEl.querySelector('.en').textContent = en || '';
    narrEl.classList.remove('is-hidden');
    clearTimeout(narr._h);
    narr._h = setTimeout(function () { narrEl.classList.add('is-hidden'); }, 3400);
  }
  function demoStop(silent) {
    demo.on = false;
    demo.timers.forEach(clearTimeout);
    demo.timers = [];
    var root = document.getElementById('jv-root');
    if (root) root.classList.remove('is-demo');
    if (narrEl) narrEl.classList.add('is-hidden');
    if (!silent && hud) hud.toast('已退出复刻模式', 1600);
  }
  function startDemo() {
    if (demo.on) { demoStop(); return; }
    demo.on = true;
    demo.t0 = U.nowMs();
    var root = document.getElementById('jv-root');
    if (root) root.classList.add('is-demo');
    JV.show('orb');
    setOrbMode('powerOn');
    if (hud) hud.toast('复刻模式 · 按 D 或 Esc 退出（原片 76s 时间轴）', 3200);
    DEMO.forEach(function (ev) {
      var delay = Math.max(0, ev.t * 1000 - (U.nowMs() - demo.t0));
      demo.timers.push(setTimeout(function () {
        if (!demo.on) return;
        if (ev.narr) narr(ev.narr.zh, ev.narr.en);
        if (ev.you && hud) {
          hud.setTranscript({ text: ev.you });
          hud.setSubtitle({ who: 'you', zh: ev.you, en: '', done: true, animate: false });
        }
        if (ev.hud && hud) {
          hud.setSubtitle({ who: 'jarvis', zh: ev.hud.zh, en: ev.hud.en, done: true });
        }
        if (ev.scene === 'city') {
          var e = JV.show('city');
          if (e && e.setMode) e.setMode(ev.mode || 'build');
        } else if (ev.scene === 'orb') {
          JV.show('orb');
          setOrbMode(ev.mode || 'idle');
        } else if (ev.mode) {
          var ent = JV.scenes.city && JV.scenes.city.entity;
          if (JV.currentSceneName() === 'city' && ent && ent.setMode) ent.setMode(ev.mode);
          else setOrbMode(ev.mode);
        }
      }, delay));
    });
    // 播放结束自动退出
    demo.timers.push(setTimeout(function () { if (demo.on) demoStop(true); }, 78200));
  }


  /* ------------------------------------------------ 自动接上本机 DeepSeek 代理 */
  var LOCAL_PROXY = [
    'http://127.0.0.1:8820/api/chat',
    'http://localhost:8820/api/chat'
  ];
  function connectLocalProxy(done) {
    var CLOUD = window.JV_CLOUD || {};
    if (CLOUD.base) {
      // 云端模式：直接用云服务的 /api/chat
      JV.settings.llm = { enabled: true, endpoint: CLOUD.base + '/api/chat', model: 'deepseek-chat', key: CLOUD.token || '' };
      JV.saveSettings();
      if (JV.agent) JV.agent.configure(JV.settings.llm);
      if (hud) { hud.setLlmStatus('llm', 'cloud'); hud.toast('云端模式已启用 · ' + CLOUD.base, 3000); }
      done && done(true);
      return;
    }
    var s = JV.settings;
    if (s.llm && s.llm.enabled && s.llm.endpoint) { done && done(false); return; }   // 尊重用户配置
    if (location.protocol === 'https:') { done && done(false); return; }             // 混合内容会被浏览器拦
    var i = 0;
    function next() {
      if (i >= LOCAL_PROXY.length) { done && done(false); return; }
      var chatUrl = LOCAL_PROXY[i++];
      var healthUrl = chatUrl.replace(/\/chat(\/completions)?$/, '/health');
      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, 1500);
      fetch(healthUrl, { signal: ctrl.signal, cache: 'no-store' }).then(function (r) { return r.json(); })
        .then(function (j) {
          clearTimeout(timer);
          if (!j || !j.ok || !j.hasKey) { next(); return; }
          s.llm = { enabled: true, endpoint: chatUrl, model: j.model || 'deepseek-chat', key: '' };
          JV.saveSettings();
          if (JV.agent) JV.agent.configure(s.llm);
          if (hud) {
            hud.setLlmStatus('proxy', j.model);
            hud.toast('已连接本机模型代理 · ' + (j.model || 'deepseek'), 3200);
          }
          done && done(true);
        })
        .catch(function () { clearTimeout(timer); next(); });
    }
    next();
  }

  /* ------------------------------------------------------------------ 输入 */
  bus.on('ui:send', function (p) {
    if (!p || !p.text) return;
    handleTurn(p.text);
  });
  bus.on('ui:mic', function () {
    if (JV.voice) {
      if (!JV.voice.isEnabled()) {
        hud.toast('正在启动语音…', 1600);
        JV.voice.enable();
        setTimeout(function () { JV.voice.start(); }, 1600);
        return;
      }
      if (JV.voice.isListening()) JV.voice.stop();
      else JV.voice.start();
    } else {
      hud.toast('当前浏览器不支持语音识别，请输入文字', 2600);
      var input = document.getElementById('jv-input');
      if (input) input.focus();
    }
  });
  bus.on('gesture:state', function (p) {
    if (!hud || !p) return;
    if (p.error) {
      hud.setGesture({ enabled: false, error: p.error });
      hud.toast('手势不可用：' + p.error + '（按 V 看自检；也可用鼠标拖拽旋转、滚轮缩放）', 6000);
      hud.toggleVoiceDiag(true);
    }
  });
  bus.on('tools:status', function (p) {
    if (!hud) return;
    hud.setToolsStatus(p || {});
    if (p && p.available) hud.toast('本机权限已接入（系统 / 文件 / 终端 / 联网）', 3200);
  });
  bus.on('tool:done', function (p) {
    if (!hud || !p) return;
    hud.toast((p.ok ? '本机操作完成：' : '本机操作失败：') + p.name, 2600);
  });
  bus.on('voice:engine', function (p) {
    if (!hud) return;
    var label = p && p.engine === 'local' ? '本机离线识别' : p && p.engine === 'webspeech' ? '浏览器语音' : '未启用';
    hud.toast('语音引擎：' + label, 2200);
    var el = document.getElementById('jv-voice-engine');
    if (el) el.textContent = label;
  });
  bus.on('agent:status', function (p) {
    if (!hud) return;
    hud.setLlmStatus(p && p.status || 'offline', p && p.model);
  });
  bus.on('gesture:intent', function (p) {
    if (!p) return;
    if (p.intent === 'wake') {
      if (JV.voice && JV.voice.sttSupported) JV.voice.start();
    } else if (p.intent === 'orb') {
      JV.show('orb'); setOrbMode('idle');
    }
  });

  /* ---------------------------------------------------------------- 快捷键 */
  var spaceDown = false;
  function isTyping(e) {
    var t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }
  function onKeydown(e) {
    if (!booted) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); enter(); }
      return;
    }
    if (isTyping(e)) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!spaceDown) {
        spaceDown = true;
        if (JV.voice && JV.voice.isEnabled()) JV.voice.start();
        else if (JV.voice) {
          hud.setMicState('listen');
          hud.toast('正在启动语音…（首次会请求麦克风）', 2200);
          JV.voice.enable();
          setTimeout(function () { JV.voice.start(); hud.setMicState('idle'); }, 1800);
        } else {
          hud.setMicState('listen');
          hud.toast('语音模块未加载 · 请用键盘输入', 2000);
          setTimeout(function () { hud.setMicState('idle'); }, 1200);
        }
      }
      return;
    }
    var k = e.key.toLowerCase();
    if (k === 'd') { startDemo(); return; }
    if (k === 'escape') {
      if (demo.on) { demoStop(); return; }
      hud.closeSettings();
      if (JV.scene && JV.currentSceneName && JV.currentSceneName() !== 'orb') { JV.show('orb'); setOrbMode('idle'); }
      return;
    }
    if (k === 'g') { if (JV.gesture) JV.gesture.toggle(); return; }
    if (k === 's') { hud.openSettings(); return; }
    if (k === 'f') {
      if (!document.fullscreenElement) { document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); }
      else { document.exitFullscreen && document.exitFullscreen(); }
      return;
    }
    if (k === '/') { e.preventDefault(); var inp = document.getElementById('jv-input'); if (inp) inp.focus(); return; }
    if (k === 'v') { hud.toggleVoiceDiag(); return; }
    if (k === 'h') {
      if (JV.gesture && JV.gesture.demo) {
        if (JV.gesture.demoOn) { JV.gesture.demoStop(); hud.toast('手势演示结束', 1500); }
        else { JV.gesture.demo('mix'); }
      }
      return;
    }
    if (k === 'r') { gestureReset(); return; }
    if (k === '+' || k === '=') { adjustZoom(0.12); return; }
    if (k === '-' || k === '_') { adjustZoom(-0.12); return; }
    if (k === '0') { JV.state.zoom = 1; zoomReset(); return; }
    if (k === 'm') { if (JV.voice) { if (JV.voice.isEnabled()) JV.voice.disable(); else JV.voice.enable(); } return; }
    if (['1', '2', '3', '4', '5'].indexOf(k) >= 0) { sceneKeys(parseInt(k, 10)); return; }
  }
  function onKeyup(e) {
    if (e.code === 'Space') {
      spaceDown = false;
      if (JV.voice && JV.voice.isListening()) JV.voice.stop();
    }
  }

  /* ------------------------------------------------------------------ 启动 */
  function enter() {
    if (booted) return;
    booted = true;
    var boot = document.getElementById('jv-boot');
    if (boot) boot.classList.add('is-gone');
    // 解锁音频（部分浏览器策略）
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { var ac = new AC(); ac.resume && ac.resume(); setTimeout(function () { try { ac.close(); } catch (e) {} }, 600); }
    } catch (e) {}
    if (JV.voice && JV.settings.voice) {
      setTimeout(function () { JV.voice.enable(); }, 300);
    }
    // 开场字幕（对齐视频第一句）；若用户已经先说话，就让位给对话
    setTimeout(function () {
      if (!hud || !hud.el) return;
      if (hud.el.subZh && hud.el.subZh.textContent) return;
      hud.setSubtitle({
        who: 'jarvis',
        zh: '兄弟们，贾维斯 2.0 已经正式上线。',
        en: 'Brothers, Jarvis 2.0 is officially launched.',
        done: true
      });
    }, 700);
    setTimeout(function () {
      var seen = false;
      try { seen = localStorage.getItem(LS_SEEN) === '1'; } catch (e) {}
      if (!seen) {
        hud.toast('空格说话 · 1–5 切场景 · G 手势 · S 设置', 4200);
        try { localStorage.setItem(LS_SEEN, '1'); } catch (e) {}
      }
    }, 2200);
    bus.emit('app:ready', {});
  }

  function initFileWarn() {
    var bar = document.getElementById('jv-filewarn');
    if (!bar) return;
    if (location.protocol !== 'file:') return;
    try { if (localStorage.getItem('jarvis2.filewarn') === 'off') return; } catch (e) {}
    bar.classList.remove('is-hidden');
    var go = document.getElementById('jv-filewarn-go');
    var close = document.getElementById('jv-filewarn-close');
    if (close) close.addEventListener('click', function () {
      bar.classList.add('is-hidden');
      try { localStorage.setItem('jarvis2.filewarn', 'off'); } catch (e) {}
    });
    if (go) go.addEventListener('click', function () {
      var target = 'http://127.0.0.1:8780/JARVIS-HUD.html';
      fetch(target, { method: 'HEAD', mode: 'no-cors' }).then(function () {
        location.href = target;
      }).catch(function () {
        alert('本地服务没启动：请先双击 JARVIS.app 或 启动Jarvis.command');
      });
    });
  }

  function init() {
    hud = JV.hud;
    initFileWarn();
    if (!hud) { console.error('[boot] HUD 未就绪'); }
    if (JV.scenes.orb) JV.show('orb');
    else if (JV.scenes.grid) JV.show('grid');
    var btn = document.getElementById('jv-enter');
    if (btn) btn.addEventListener('click', enter);
    document.addEventListener('keydown', onKeydown);
    document.addEventListener('keyup', onKeyup);
    var boot = document.getElementById('jv-boot');
    if (boot) boot.addEventListener('click', function (e) { if (e.target === boot) enter(); });
    // 首次进入后 8s 未点击也自动进入（避免卡在启动页）
    setTimeout(function () { if (!booted) { /* 保持等待用户手势，不自动进入 */ } }, 8000);
    // 启动 1.2s 后尝试自动接上本机代理（不阻塞界面）
    setTimeout(function () { connectLocalProxy(); }, 1200);
  }

  function start() {
    try { JV.start(); } catch (e) { console.error('[JV.start]', e); }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }

  window.addEventListener('error', function (e) {
    console.error('[JARVIS] 运行错误：', e.message);
  });

  window.__jvBoot = { enter: enter, init: init, booted: function () { return booted; },
    demo: startDemo, demoStop: demoStop, demoOn: function () { return demo.on; },
    connectProxy: connectLocalProxy };
  start();
})();
