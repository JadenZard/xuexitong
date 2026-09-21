(function () {
    const APP_KEY = '__xuexitongPlayerV3';
    const BOOT_TIMER_KEY = '__xuexitongPlayerV3BootTimer';

    const previousApp = window[APP_KEY];
    if (previousApp && typeof previousApp.destroy === 'function') {
        previousApp.destroy();
    }
    if (window[BOOT_TIMER_KEY]) {
        clearInterval(window[BOOT_TIMER_KEY]);
        window[BOOT_TIMER_KEY] = null;
    }

    if (typeof window.jQuery === 'undefined') {
        const script = document.createElement('script');
        script.src = 'https://code.jquery.com/jquery-3.6.0.min.js';
        script.type = 'text/javascript';
        script.onload = function () {
            console.log("jQuery loaded.");
            waitForCoursePage();
        };
        document.head.appendChild(script);
    } else {
        waitForCoursePage();
    }

    function waitForCoursePage() {
        let attempts = 0;
        const maxAttempts = 20;
        window[BOOT_TIMER_KEY] = setInterval(() => {
            if ($('#coursetree').length > 0) {
                clearInterval(window[BOOT_TIMER_KEY]);
                window[BOOT_TIMER_KEY] = null;
                initializePlayer();
                return;
            }
            attempts++;
            if (attempts >= maxAttempts) {
                clearInterval(window[BOOT_TIMER_KEY]);
                window[BOOT_TIMER_KEY] = null;
                console.error('%c脚本启动超时：未检测到课程目录（#coursetree）。请确认当前处于课程播放页。', 'color:#F44336;font-weight:bold');
            }
        }, 1000);
    }

    function initializePlayer() {
        const app = {
            configs: {
                playbackRate: 1.0,
                autoplay: true,
                retryInterval: 2000,
                maxRetries: 10,
                videoCheckInterval: 1000,
                guardNoProgressMs: 7000,
                guardResumeCooldownMs: 1500,
                autoAdvanceNoVideo: true,
                pdfScrollStep: 400,
                pdfScrollInterval: 150,
                pdfScrollMaxRounds: 600,
                pdfScrollStableRounds: 3,
                maxConsecutiveNextUnit: 6,
            },
            _videoEl: null,
            _treeContainerEl: null,
            _isPlaying: false,
            _currentRetryCount: 0,
            _checkInterval: null,
            _eventVideoEl: null,
            _boundVideoHandlers: null,
            _nextUnitPending: false,
            _chapterAdvanceTimes: 0,
            _multiTabHandling: false,
            _contentPageHandling: false,
            _consecutiveNextUnit: 0,
            _quizHandling: false,
            _cellData: {
                cells: 0,
                nCells: 0,
                currentCellIndex: 0,
                currentNCellIndex: 0,
                currentVideoTitle: "",
            },
            get cellData() {
                return this._cellData;
            },
            run() {
                console.log("%c=== 学习通自动刷课脚本 V3 优化版启动 ===", "color:#4CAF50;font-size:16px;font-weight:bold");
                this._nextUnitPending = false;
                this._chapterAdvanceTimes = 0;
                this._multiTabHandling = false;
                this._contentPageHandling = false;
                this._consecutiveNextUnit = 0;
                this._quizHandling = false;
                this._getTreeContainer();
                this._initCellData();
                this._videoEl = null;
                this._getVideoEl();
                this._clearCheckInterval();
                this._bindStepNavigation();
                this.play();
            },
            nextUnit() {
                if (this._nextUnitPending) {
                    console.warn('%c已有小节切换正在进行，忽略重复请求', 'color:#FF9800');
                    return;
                }
                this._nextUnitPending = true;
                this._clearCheckInterval();

                this._consecutiveNextUnit++;
                if (this._consecutiveNextUnit > this.configs.maxConsecutiveNextUnit) {
                    console.error(`%c已连续跳过 ${this.configs.maxConsecutiveNextUnit} 个小节仍未找到可播内容，已暂停。请检查页面，或执行 app._consecutiveNextUnit = 0 重置。`, 'color:#F44336;font-weight:bold');
                    this._nextUnitPending = false;
                    return;
                }

                console.log(`%c=== 准备切换到下一小节（连续第 ${this._consecutiveNextUnit} 次）===`, "color:#2196F3;font-size:14px");
                try {
                    const el = this._getTreeContainer();
                    const cells = el.children("ul").children("li");
                    const nCells = $(cells.get(this._cellData.currentCellIndex)).find('.posCatalog_select:not(.firstLayer)');

                    if (nCells.length > this._cellData.currentNCellIndex + 1) {
                        const nextNIndex = this._cellData.currentNCellIndex + 1;
                        console.log(`%c切换到同章节下一个视频: ${nextNIndex + 1}/${nCells.length}`, "color:#FF9800");
                        this.playCurrentIndex(nCells.get(nextNIndex));
                    } else {
                        const nextIndex = this._cellData.currentCellIndex + 1;
                        if (nextIndex >= cells.length) {
                            console.log("%c=====================================", "color:#4CAF50;font-size:16px");
                            console.log("%c==============本课程学习完成了==============", "color:#4CAF50;font-size:16px;font-weight:bold");
                            console.log("%c=====================================", "color:#4CAF50;font-size:16px");
                            this._nextUnitPending = false;
                            return;
                        }
                        console.log(`%c切换到下一个章节: ${nextIndex + 1}/${cells.length}`, "color:#FF9800");
                        this._cellData.currentCellIndex = nextIndex;
                        this._cellData.currentNCellIndex = 0;
                        this.playCurrentIndex();
                    }
                } catch (error) {
                    this._nextUnitPending = false;
                    console.error('切换下一小节失败:', error);
                }
            },
            _clearCheckInterval() {
                if (this._checkInterval) {
                    clearInterval(this._checkInterval);
                    this._checkInterval = null;
                }
            },
            _startVideoMonitoring() {
                this._clearCheckInterval();
                this._guardLastTime = 0;
                this._guardLastWallTs = 0;
                this._guardLastResumeTs = 0;
                this._checkInterval = setInterval(() => {
                    this._checkVideoStatus();
                    if (this._hasVideoQuiz()) {
                        this._autoAnswerVideoQuiz();
                    }
                }, this.configs.videoCheckInterval);
            },
            _tryResumePlayback(reason) {
                const now = Date.now();
                if (now - this._guardLastResumeTs < this.configs.guardResumeCooldownMs) {
                    return;
                }
                this._guardLastResumeTs = now;

                const video = this._videoEl || this._getVideoEl();
                if (!video || !this._isPlaying) return;

                console.log(`%c触发视频保活恢复(${reason})`, "color:#607D8B");
                video.play().catch((e) => {
                    console.warn("直接恢复播放失败，尝试静音恢复:", e);
                    video.muted = true;
                    video.play().catch((err) => {
                        console.error("静音恢复播放失败:", err);
                    });
                });
            },
            _checkVideoStatus() {
                try {
                    if (this._hasVideoQuiz()) {
                        return;
                    }
                    const video = this._videoEl || this._getVideoEl();
                    if (!video) return;

                    if (video.paused && this._isPlaying) {
                        console.log("%c检测到视频暂停，尝试恢复播放...", "color:#FF5722");
                        this._tryResumePlayback("paused");
                    } else if (this._isPlaying && !video.ended) {
                        const now = Date.now();
                        const current = Number(video.currentTime || 0);
                        if (this._guardLastWallTs === 0) {
                            this._guardLastWallTs = now;
                            this._guardLastTime = current;
                        } else {
                            const stalled = Math.abs(current - this._guardLastTime) < 0.01;
                            const stalledMs = now - this._guardLastWallTs;
                            if (stalled && stalledMs >= this.configs.guardNoProgressMs) {
                                this._tryResumePlayback("no-progress");
                                this._guardLastWallTs = now;
                                this._guardLastTime = Number(video.currentTime || 0);
                            } else if (!stalled) {
                                this._guardLastWallTs = now;
                                this._guardLastTime = current;
                            }
                        }
                    }

                    if (video.ended && this._isPlaying) {
                        console.log("%c检测到视频结束，准备切换下一个...", "color:#9C27B0");
                        this._isPlaying = false;
                        this._clearCheckInterval();
                        setTimeout(async () => {
                            const hasMore = await this._playNextVideoInCurrentSection();
                            if (!hasMore) {
                                this.nextUnit();
                            }
                        }, 1000);
                    }
                } catch (e) {
                    console.error("视频状态检查失败:", e);
                }
            },
            _tryTimes: 0,
            _stepAdvanceTimes: 0,
            _stepSwitchAt: 0,
            _stepSwitchPending: false,
            _delayedNextUnitTimer: null,
            _guardLastTime: 0,
            _guardLastWallTs: 0,
            _guardLastResumeTs: 0,
            async play() {
                try {
                    const el = this._videoEl || this._getVideoEl();
                    if (el == null) {
                        if (this._currentStepTitle() === '视频') {
                            throw new Error('视频组件尚未加载完成');
                        }

                        const tabs = [...document.querySelectorAll('.prev_white')];
                        const pdfs = this._getPdfFrames();
                        const videos = this._getAllVideoFrames();
                        if (tabs.some(t => t.textContent.includes('教材课件')) ||
                            tabs.some(t => t.textContent.includes('案例资源')) ||
                            pdfs.length > 0 ||
                            videos.length > 0) {
                            console.log(`%c检测到内容页（tab=${tabs.length}, PDF=${pdfs.length}, 视频=${videos.length}），启动内容处理流程`, 'color:#2196F3;font-weight:bold');
                            this._isPlaying = false;
                            this._clearCheckInterval();
                            this._handleContentPage();
                            return;
                        }

                        if (this._advanceLearningStep()) {
                            console.log("%c当前不在视频页，已尝试切到下一学习步骤，2秒后重试", "color:#607D8B");
                            setTimeout(() => {
                                this.play();
                            }, 2000);
                            return;
                        }
                        if (this._isChapterTest()) {
                            this._advanceChapterTest();
                            return;
                        }
                        this._isPlaying = false;
                        this._clearCheckInterval();
                        if (this.configs.autoAdvanceNoVideo) {
                            console.warn('%c当前小节未发现视频，按配置切换到下一小节', 'color:#FF9800');
                            this.nextUnit();
                        } else {
                            console.warn('%c当前小节未发现视频或可识别的学习步骤，已安全停止。确认无需完成课件后，可执行 app.nextUnit()。', 'color:#FF9800');
                        }
                        return;
                    }

                    this._consecutiveNextUnit = 0;
                    this._isPlaying = true;
                    this._videoEventHandle();
                    el.playbackRate = this.configs.playbackRate;

                    try {
                        await el.play();
                        this._tryTimes = 0;
                        console.log(`%c视频开始播放，倍速: ${el.playbackRate}x`, "color:#4CAF50");
                        this._startVideoMonitoring();
                    } catch (playError) {
                        console.error("视频播放失败:", playError);
                        this._handlePlayError(playError);
                    }
                } catch (e) {
                    if (this._tryTimes >= this.configs.maxRetries) {
                        console.error("%c视频播放失败，已达到最大重试次数", "color:#F44336;font-weight:bold", e);
                        this._clearCheckInterval();
                        return;
                    }
                    this._tryTimes++;
                    console.log(`%c播放失败，${this.configs.retryInterval/1000}秒后重试 (${this._tryTimes}/${this.configs.maxRetries})`, "color:#FF9800");
                    setTimeout(() => {
                        this.play();
                    }, this.configs.retryInterval);
                }
            },
            /* ============ 内容页统一处理（tab / PDF / 视频） ============ */

            _isMultiTabPage() {
                const tabs = [...document.querySelectorAll('.prev_white')]
                    .map(e => (e.textContent || '').replace(/\s+/g, ''));
                return tabs.some(t => t.includes('教材课件')) || tabs.some(t => t.includes('案例资源'));
            },

            _hasPdfFrames() {
                return this._getPdfFrames().length > 0;
            },

            _clickTab(namePart) {
                const tab = [...document.querySelectorAll('.prev_white')].find(e =>
                    (e.textContent || '').replace(/\s+/g, '').includes(namePart)
                );
                if (!tab) return false;
                console.log(`%c点击 tab：${namePart}`, 'color:#2196F3');
                tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                return true;
            },

            _sleep(ms) {
                return new Promise(res => setTimeout(res, ms));
            },

            _getOuterIframe() {
                return document.querySelectorAll('iframe')[0];
            },

            // ★ 新增：递归找所有层级的 PDF iframe
            _getPdfFrames() {
                const outer = this._getOuterIframe();
                if (!outer) return [];
                let odoc;
                try {
                    odoc = outer.contentDocument || outer.contentWindow.document;
                } catch (e) { return []; }
                if (!odoc) return [];

                const found = [];
                const seenDocs = new Set();
                const seenFrames = new Set();

                const walk = (doc, depth) => {
                    if (depth > 6 || !doc || seenDocs.has(doc)) return;
                    seenDocs.add(doc);
                    try {
                        const pdfs = doc.querySelectorAll(
                            'iframe.ans-attach-online.insertdoc-online-pdf, ' +
                            'iframe.insertdoc-online-pdf, ' +
                            'iframe[class*="insertdoc"]'
                        );
                        pdfs.forEach(f => {
                            if (!seenFrames.has(f)) {
                                seenFrames.add(f);
                                found.push(f);
                            }
                        });

                        doc.querySelectorAll('iframe').forEach(f => {
                            let sub;
                            try { sub = f.contentDocument || f.contentWindow.document; } catch(e){ return; }
                            if (sub) walk(sub, depth + 1);
                        });
                    } catch(e){}
                };

                walk(odoc, 0);
                return found;
            },

            _getAllVideoFrames() {
                const outer = this._getOuterIframe();
                if (!outer) return [];
                let odoc;
                try {
                    odoc = outer.contentDocument || outer.contentWindow.document;
                } catch (e) { return []; }
                if (!odoc) return [];
                return [...odoc.querySelectorAll('iframe.ans-insertvideo-online')];
            },

            _getPdfScrollEl(pdfIframe) {
                try {
                    const idoc = pdfIframe.contentDocument || pdfIframe.contentWindow.document;
                    if (!idoc) return null;
                    const panView = idoc.querySelector('iframe#panView');
                    if (!panView) return null;
                    const pdoc = panView.contentDocument || panView.contentWindow.document;
                    if (!pdoc) return null;
                    return pdoc.documentElement;
                } catch (e) {
                    console.error('获取 PDF 滚动元素失败:', e);
                    return null;
                }
            },

            async _scrollOnePdf(pdfIframe, index) {
                const el = this._getPdfScrollEl(pdfIframe);
                if (!el) {
                    console.warn(`%c第 ${index+1} 个 PDF 找不到滚动元素，跳过`, 'color:#FF9800');
                    return false;
                }

                const total = el.scrollHeight;
                const view = el.clientHeight;
                console.log(`%c开始滚动第 ${index+1} 个 PDF（scrollH=${total}, clientH=${view}）`, 'color:#607D8B');

                let stableCount = 0;
                let round = 0;
                const step = this.configs.pdfScrollStep;
                const interval = this.configs.pdfScrollInterval;
                const maxRounds = this.configs.pdfScrollMaxRounds;
                const stableTarget = this.configs.pdfScrollStableRounds;

                while (round++ < maxRounds) {
                    const cur = el.scrollTop;
                    const max = el.scrollHeight - el.clientHeight;

                    if (cur >= max - 5) {
                        stableCount++;
                        if (stableCount >= stableTarget) break;
                    } else {
                        stableCount = 0;
                        el.scrollTop = Math.min(cur + step, max);
                    }
                    await this._sleep(interval);
                }

                console.log(`%c第 ${index+1} 个 PDF 滚动完成（scrollTop=${el.scrollTop}, max=${el.scrollHeight - el.clientHeight}）`, 'color:#4CAF50');
                return true;
            },

            async _scrollAllPdfs() {
                const pdfs = this._getPdfFrames();
                if (pdfs.length === 0) return;
                console.log(`%c开始处理 ${pdfs.length} 个 PDF 课件`, 'color:#9C27B0;font-weight:bold');
                for (let i = 0; i < pdfs.length; i++) {
                    await this._scrollOnePdf(pdfs[i], i);
                    await this._sleep(1000);
                }
                console.log('%c所有 PDF 课件处理完成', 'color:#4CAF50');
            },

            _getVideoInFrame(frame) {
                try {
                    const fdoc = frame.contentDocument || frame.contentWindow.document;
                    if (!fdoc) return null;
                    return fdoc.querySelector('video');
                } catch (e) {
                    return null;
                }
            },

            async _playNextVideoInCurrentSection() {
                const frames = this._getAllVideoFrames();
                if (frames.length === 0) return false;

                console.log(`%c本小节共有 ${frames.length} 个视频，检查哪个还没播...`, 'color:#607D8B');

                for (let i = 0; i < frames.length; i++) {
                    const v = this._getVideoInFrame(frames[i]);
                    if (!v) continue;
                    const done = v.ended || (v.duration && v.currentTime >= v.duration - 1);
                    console.log(`  视频[${i+1}]  ended=${v.ended} currentTime=${(v.currentTime||0).toFixed(1)} duration=${isNaN(v.duration)?'?':v.duration.toFixed(1)} ${done ? '✅已播完' : '⏳未播'}`);

                    if (!done) {
                        console.log(`%c→ 播放第 ${i+1} 个视频`, 'color:#2196F3');
                        this._videoEl = v;

                        try {
                            frames[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
                        } catch (e) {}
                        await this._sleep(800);

                        this._eventVideoEl = null;
                        this._boundVideoHandlers = null;
                        this._videoEventHandle();

                        this._isPlaying = true;
                        this._nextUnitPending = false;
                        this._consecutiveNextUnit = 0;
                        try {
                            v.playbackRate = this.configs.playbackRate;
                            await v.play();
                            console.log(`%c视频[${i+1}] 开始播放，倍速 ${v.playbackRate}x`, 'color:#4CAF50');
                            this._startVideoMonitoring();
                        } catch (err) {
                            console.error(`播放视频[${i+1}] 失败:`, err);
                            this._handlePlayError(err);
                        }
                        return true;
                    }
                }

                console.log('%c本小节所有视频都已播完', 'color:#4CAF50');
                return false;
            },

            async _handleContentPage() {
                if (this._contentPageHandling) {
                    console.warn('%c内容页处理中，忽略重复请求', 'color:#FF9800');
                    return;
                }
                this._contentPageHandling = true;
                try {
                    const tabs = [...document.querySelectorAll('.prev_white')];
                    const hasTextbook = tabs.some(t => t.textContent.includes('教材课件'));
                    const hasResource = tabs.some(t => t.textContent.includes('案例资源'));

                    if (hasTextbook || hasResource) {
                        console.log('%c===== 双 tab 页 =====', 'color:#9C27B0;font-weight:bold');
                        if (hasTextbook) {
                            this._clickTab('教材课件');
                            await this._sleep(1500);
                            await this._scrollAllPdfs();
                            this._consecutiveNextUnit = 0;
                        }
                        if (hasResource) {
                            this._clickTab('案例资源');
                            await this._sleep(2000);
                            this._videoEl = null;
                            this._isPlaying = false;
                            this._nextUnitPending = false;
                            this._contentPageHandling = false;
                            const started = await this._playNextVideoInCurrentSection();
                            if (!started) {
                                this.nextUnit();
                            }
                            return;
                        }
                        this._contentPageHandling = false;
                        this.nextUnit();
                        return;
                    }

                    const pdfs = this._getPdfFrames();
                    const videos = this._getAllVideoFrames();
                    console.log(`%c===== 内容页（无 tab）：${pdfs.length} 个 PDF, ${videos.length} 个视频 =====`, 'color:#9C27B0;font-weight:bold');

                    if (pdfs.length > 0) {
                        await this._scrollAllPdfs();
                        this._consecutiveNextUnit = 0;
                    }

                    if (videos.length > 0) {
                        this._videoEl = null;
                        this._isPlaying = false;
                        this._nextUnitPending = false;
                        this._contentPageHandling = false;
                        const started = await this._playNextVideoInCurrentSection();
                        if (!started) {
                            this.nextUnit();
                        }
                        return;
                    }

                    if (pdfs.length > 0) {
                        this._contentPageHandling = false;
                        this.nextUnit();
                        return;
                    }

                    this._contentPageHandling = false;
                    if (this.configs.autoAdvanceNoVideo) {
                        console.warn('%c内容页里没找到任何可处理内容，跳下一节', 'color:#FF9800');
                        this.nextUnit();
                    } else {
                        console.warn('%c内容页里没找到任何可处理内容，已停止', 'color:#FF9800');
                    }
                } catch (e) {
                    console.error('内容页处理失败:', e);
                    this._contentPageHandling = false;
                }
            },

            /* ============ 互动题（视频中弹出）自动答题 ============ */

            _getQuizDoc() {
                try {
                    const outer = document.querySelectorAll('iframe')[0];
                    if (!outer) return null;
                    const odoc = outer.contentDocument || outer.contentWindow.document;
                    if (!odoc) return null;

                    const vfs = [...odoc.querySelectorAll('iframe.ans-insertvideo-online')];
                    if (vfs.length === 0) return null;

                    const hasPendingQuiz = (vdoc) => {
                        if (!vdoc) return false;
                        const topic = vdoc.querySelector('.tkTopic');
                        if (!topic) return false;
                        try {
                            const style = vdoc.defaultView.getComputedStyle(topic);
                            if (style.display === 'none' || style.visibility === 'hidden') return false;
                        } catch (e) {}
                        const cont = vdoc.querySelector('#videoquiz-continue');
                        if (cont) {
                            try {
                                const cstyle = vdoc.defaultView.getComputedStyle(cont);
                                if (cstyle.display !== 'none' && cstyle.visibility !== 'hidden') return false;
                            } catch (e) {}
                        }
                        return true;
                    };

                    if (this._videoEl) {
                        for (const vf of vfs) {
                            let vdoc;
                            try { vdoc = vf.contentDocument || vf.contentWindow.document; } catch (e) { continue; }
                            if (!vdoc) continue;
                            const v = vdoc.querySelector('video');
                            if (v && v === this._videoEl) {
                                if (hasPendingQuiz(vdoc)) return vdoc;
                                break;
                            }
                        }
                    }

                    for (const vf of vfs) {
                        let vdoc;
                        try { vdoc = vf.contentDocument || vf.contentWindow.document; } catch (e) { continue; }
                        if (!vdoc) continue;
                        if (hasPendingQuiz(vdoc)) return vdoc;
                    }

                    return null;
                } catch (e) {
                    return null;
                }
            },

            _hasVideoQuiz() {
                return this._getQuizDoc() !== null;
            },

            async _autoAnswerVideoQuiz() {
                if (this._quizHandling) return;
                this._quizHandling = true;
                try {
                    const vdoc = this._getQuizDoc();
                    if (!vdoc) { this._quizHandling = false; return false; }

                    const topic = vdoc.querySelector('.tkTopic');
                    if (!topic) { this._quizHandling = false; return false; }

                    const titleEl = vdoc.querySelector('.tkItem_title');
                    const title = titleEl ? titleEl.textContent.trim() : '';
                    const typeEl = vdoc.querySelector('.tkTopic_title');
                    const type = typeEl ? typeEl.textContent.trim() : '';
                    console.log(`%c检测到互动题：${title}`, 'color:#E91E63;font-weight:bold');
                    console.log(`%c题型：${type}`, 'color:#9C27B0');

                    const opts = [...vdoc.querySelectorAll('li.ans-videoquiz-opt')];
                    if (opts.length === 0) {
                        console.warn('未找到选项');
                        this._quizHandling = false;
                        return false;
                    }
                    const n = opts.length;
                    console.log(`%c共 ${n} 个选项`, 'color:#607D8B');

                    const all = [];
                    for (let mask = 1; mask < (1 << n); mask++) {
                        const combo = [];
                        for (let i = 0; i < n; i++) {
                            if (mask & (1 << i)) combo.push(i);
                        }
                        all.push(combo);
                    }
                    const totalOpts = n;
                    all.sort((a, b) => {
                        const rank = (combo) => {
                            if (combo.length === 1) return 0;
                            if (combo.length === totalOpts) return 1;
                            return 2 + combo.length;
                        };
                        const ra = rank(a), rb = rank(b);
                        if (ra !== rb) return ra - rb;
                        return a.length - b.length;
                    });
                    const combos = all;

                    console.log(`%c共 ${combos.length} 种可能组合，将依次尝试`, 'color:#2196F3');

                    for (let round = 0; round < combos.length; round++) {
                        const combo = combos[round];
                        const comboStr = combo.map(i => String.fromCharCode(65 + i)).join('');
                        console.log(`%c第 ${round + 1}/${combos.length} 次尝试：选 [${comboStr}]`, 'color:#2196F3');

                        const inputs = vdoc.querySelectorAll('li.ans-videoquiz-opt input');
                        inputs.forEach(inp => {
                            if (inp.checked) {
                                const pLabel = inp.closest('label') || inp.parentElement;
                                if (pLabel) pLabel.click();
                            }
                        });
                        await this._sleep(200);

                        for (const idx of combo) {
                            const targetLi = opts[idx];
                            if (!targetLi) continue;
                            const label = targetLi.querySelector('label') || targetLi;
                            label.click();
                            await this._sleep(150);
                        }

                        await this._sleep(300);

                        const submitBtn = vdoc.querySelector('#videoquiz-submit');
                        if (submitBtn) {
                            submitBtn.click();
                            console.log('已提交，等待结果...');
                        } else {
                            console.warn('未找到提交按钮');
                            this._quizHandling = false;
                            return false;
                        }

                        await this._sleep(1800);

                        const contBtn = vdoc.querySelector('#videoquiz-continue');
                        if (contBtn) {
                            let visible = false;
                            try {
                                const cstyle = vdoc.defaultView.getComputedStyle(contBtn);
                                visible = (cstyle.display !== 'none' && cstyle.visibility !== 'hidden');
                            } catch (e) {}
                            if (visible) {
                                console.log(`%c✅ 答对了！第 ${round + 1} 次尝试成功，答案：[${comboStr}]`, 'color:#4CAF50;font-weight:bold');
                                contBtn.click();
                                console.log('%c已点击【继续学习】', 'color:#4CAF50');
                                await this._sleep(1200);
                                const v = this._videoEl || this._getVideoEl();
                                if (v && v.paused) {
                                    try { await v.play(); } catch(e) {}
                                }
                                this._quizHandling = false;
                                return true;
                            }
                        }

                        console.log(`%c第 ${round + 1} 次答错，尝试下一个组合`, 'color:#FF9800');
                        await this._sleep(500);
                    }

                    console.warn('%c所有组合都试过了，还是没答对', 'color:#F44336');
                    this._quizHandling = false;
                    return false;
                } catch (e) {
                    console.error('自动答互动题出错:', e);
                    this._quizHandling = false;
                    return false;
                }
            },
            /* ============ 步骤 / 章节测验处理 ============ */

            _advanceLearningStep() {
                if (this._stepSwitchPending && Date.now() - this._stepSwitchAt < 4000) {
                    return true;
                }

                const prevTitle = document.getElementsByClassName("prev_title")[0];
                const currentStepTitle = prevTitle ? (prevTitle.title || prevTitle.textContent || "").trim() : "";

                if (currentStepTitle === "章节测验" || currentStepTitle === "视频") {
                    return false;
                }

                const clickElement = (el, label) => {
                    if (!el) return false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    console.log(`%c尝试点击${label}`, "color:#2196F3");
                    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                    return true;
                };

                const videoTab = $(".prev_white:visible").filter((_, el) => {
                    const text = ($(el).text() || "").replace(/\s+/g, "");
                    return text === "2视频" || text === "视频";
                }).get(0);
                if (clickElement(videoTab, "“视频”页签")) {
                    return true;
                }

                return false;
            },
            _currentStepTitle() {
                const prevTitle = document.getElementsByClassName('prev_title')[0];
                return prevTitle ? (prevTitle.title || prevTitle.textContent || '').trim() : '';
            },
            _isChapterTest() {
                return this._currentStepTitle() === '章节测验';
            },
            _advanceChapterTest() {
                if (this._chapterAdvanceTimes >= 3) {
                    console.error('%c章节测验页面连续跳转失败，已停止以避免页面循环。请手动处理后执行 app.run()。', 'color:#F44336;font-weight:bold');
                    return;
                }

                const nextButton = $('#prevNextFocusNext:visible, #right1:visible, .nextChapter:visible').first().get(0);
                if (!nextButton) {
                    console.warn('%c未找到章节测验的下一步按钮，已停止。', 'color:#FF9800');
                    return;
                }

                this._chapterAdvanceTimes++;
                console.log('%c检测到章节测验，尝试进入下一学习步骤', 'color:#607D8B');
                nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                setTimeout(() => this.play(), 2000);
            },
            _bindStepNavigation() {
                if (this._stepNavigationBound) {
                    return;
                }
                this._stepNavigationBound = true;

                const reenterVideoMode = () => {
                    this._videoEl = null;
                    this._isPlaying = false;
                    this._stepSwitchPending = true;
                    this._stepSwitchAt = Date.now();
                    setTimeout(() => {
                        try {
                            this._initCellData();
                        } catch (e) {}
                        this.play();
                    }, 1800);
                };

                $(document).off('click.xuexitongPlayerV3', '.prev_white').on('click.xuexitongPlayerV3', '.prev_white', (e) => {
                    const text = ($(e.currentTarget).text() || "").replace(/\s+/g, "");
                    if (text.includes("视频")) {
                        console.log(`%c检测到步骤切换点击：${text}，准备重新接管视频页`, "color:#607D8B");
                        reenterVideoMode();
                    }
                });
            },
            _handlePlayError(error) {
                console.error("播放错误详情:", error);
                const video = this._videoEl || this._getVideoEl();
                if (video) {
                    video.muted = true;
                    video.play().then(() => {
                        console.log("%c静音播放成功", "color:#4CAF50");
                        this._tryTimes = 0;
                        this._startVideoMonitoring();
                        if (this._delayedNextUnitTimer) {
                            clearTimeout(this._delayedNextUnitTimer);
                            this._delayedNextUnitTimer = null;
                        }
                    }).catch(e => {
                        console.error("静音播放也失败:", e);
                        if (this._delayedNextUnitTimer) {
                            clearTimeout(this._delayedNextUnitTimer);
                        }
                        this._isPlaying = false;
                        if (this._tryTimes >= this.configs.maxRetries) {
                            console.error('%c静音播放失败，已达到最大重试次数', 'color:#F44336;font-weight:bold', e);
                            return;
                        }
                        this._tryTimes++;
                        this._delayedNextUnitTimer = setTimeout(() => {
                            this._delayedNextUnitTimer = null;
                            this.play();
                        }, this.configs.retryInterval);
                    });
                }
            },

            playCurrentIndex(nCell) {
                if (!nCell) {
                    const el = this._getTreeContainer();
                    const cells = el.children("ul").children("li");
                    const nCells = $(cells.get(this._cellData.currentCellIndex)).find('.posCatalog_select:not(.firstLayer)');
                    nCell = nCells.get(this._cellData.currentNCellIndex);
                }

                const $nCell = $(nCell);
                const clickableSpan = $nCell.find(".posCatalog_name")[0];
                if (!clickableSpan) {
                    console.error("%c===========找不到可点击的课程节点，播放下一个视频失败==============", "color:#F44336");
                    this._nextUnitPending = false;
                    return;
                }

                const targetTitle = $(clickableSpan).attr('title') || clickableSpan.textContent.trim();
                console.log(`%c准备切换到: ${targetTitle}`, "color:#2196F3");

                this._switchToNode(clickableSpan, targetTitle);
            },

            async _switchToNode(clickableSpan, targetTitle) {
                const getActiveTitle = () => {
                    const active = document.querySelector('#coursetree .posCatalog_active .posCatalog_name');
                    return active ? (active.getAttribute('title') || active.textContent.trim() || '') : '';
                };

                const MAX_CLICK_RETRY = 3;
                const MAX_WAIT_MS = 15000;
                const POLL_INTERVAL = 500;

                for (let clickTry = 1; clickTry <= MAX_CLICK_RETRY; clickTry++) {
                    console.log(`%c点击第 ${clickTry}/${MAX_CLICK_RETRY} 次: ${targetTitle}`, 'color:#2196F3');

                    this._videoEl = null;
                    this._isPlaying = false;
                    try {
                        clickableSpan.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
                    } catch (e) {
                        try { clickableSpan.click(); } catch(e2) {}
                    }

                    const startTs = Date.now();
                    let switched = false;
                    while (Date.now() - startTs < MAX_WAIT_MS) {
                        await this._sleep(POLL_INTERVAL);

                        const nowTitle = getActiveTitle();
                        if (nowTitle && (nowTitle === targetTitle || nowTitle.includes(targetTitle.substring(0, 10)) || targetTitle.includes(nowTitle.substring(0, 10)))) {
                            console.log(`%c✅ 切换成功（用时 ${((Date.now() - startTs)/1000).toFixed(1)}s）：${nowTitle}`, 'color:#4CAF50');
                            switched = true;
                            break;
                        }
                    }

                    if (switched) {
                        await this._sleep(1500);
                        this._initCellData();
                        this._nextUnitPending = false;
                        if (this.configs.autoplay) {
                            this.play();
                        }
                        return;
                    }

                    console.warn(`%c第 ${clickTry} 次点击后未切换成功，准备重试...`, 'color:#FF9800');
                    await this._sleep(1000);
                }

                console.error(`%c❌ 切换失败：已尝试 ${MAX_CLICK_RETRY} 次，节点 = "${targetTitle}"`, 'color:#F44336;font-weight:bold');
                console.warn('%c脚本已暂停，避免死循环。请手动点击目标节点，或执行 app.run() 重试。', 'color:#FF9800');
                this._nextUnitPending = false;
                this._isPlaying = false;
                this._clearCheckInterval();
            },

            _initCellData() {
                const el = this._getTreeContainer();
                const cells = el.children("ul").children("li");
                this._cellData.cells = cells.length;
                let nCellCounts = 0;
                let foundCurrent = false;

                cells.each((i, v) => {
                    const nCells = $(v).find('.posCatalog_select:not(.firstLayer)');
                    nCellCounts += nCells.length;
                    nCells.each((j, e) => {
                        const _el = $(e);
                        if (_el.hasClass("posCatalog_active")) {
                            this._cellData.currentCellIndex = i;
                            this._cellData.currentNCellIndex = j;
                            foundCurrent = true;
                            const titleSpan = _el.find('.posCatalog_name')[0];
                            if (titleSpan) {
                                this._cellData.currentVideoTitle = $(titleSpan).attr('title');
                            }
                        }
                    });
                });

                this._cellData.nCells = nCellCounts;

                if (!foundCurrent && nCellCounts > 0) {
                    console.warn("%c未找到当前激活的视频节点，可能需要手动选择", "color:#FF9800");
                }

                console.log(`%c课程信息: ${this._cellData.cells}章, ${this._cellData.nCells}节, 当前: 第${this._cellData.currentCellIndex + 1}章第${this._cellData.currentNCellIndex + 1}节`, "color:#607D8B");
            },
            _getTreeContainer() {
                if (!this._treeContainerEl) {
                    const el = $('#coursetree');
                    if (el.length <= 0) {
                        throw new Error("找不到视频列表");
                    }
                    this._treeContainerEl = el;
                }
                return this._treeContainerEl;
            },
            _getVideoEl() {
                if (this._videoEl && !this._videoEl.isConnected) {
                    this._videoEl = null;
                }
                if (!this._videoEl) {
                    try {
                        const findVideo = (frame, depth) => {
                            if (depth > 2) return null;
                            const frameDocument = frame.contentDocument || frame.contentWindow?.document;
                            if (!frameDocument) return null;
                            const $frameDocument = $(frameDocument);
                            const directVideo = $frameDocument.find('video#video_html5_api, video[id*="video_html5"]').get(0);
                            if (directVideo) return directVideo;

                            const nestedFrames = $frameDocument.find('iframe.ans-insertvideo-online, iframe[src*="video"]');
                            for (const nestedFrame of nestedFrames.toArray()) {
                                const nestedVideo = findVideo(nestedFrame, depth + 1);
                                if (nestedVideo) return nestedVideo;
                            }
                            return null;
                        };

                        for (const frame of $('iframe').toArray()) {
                            const video = findVideo(frame, 0);
                            if (video) {
                                this._videoEl = video;
                                break;
                            }
                        }
                    } catch (e) {
                        console.error("获取视频元素失败:", e);
                        return null;
                    }
                }
                if (!this._videoEl) return null;
                return this._videoEl;
            },
            _videoEventHandle() {
                const el = this._videoEl;
                if (!el) {
                    console.log("videoEl未加载");
                    return;
                }

                if (this._eventVideoEl === el) return;
                this._detachVideoEvents();
                this._eventVideoEl = el;
                this._boundVideoHandlers = {
                    ended: this._handleVideoEnded.bind(this),
                    loadedmetadata: this._handleVideoLoaded.bind(this),
                    play: this._handleVideoPlay.bind(this),
                    pause: this._handleVideoPause.bind(this),
                };

                el.addEventListener('ended', this._boundVideoHandlers.ended);
                el.addEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                el.addEventListener('play', this._boundVideoHandlers.play);
                el.addEventListener('pause', this._boundVideoHandlers.pause);
            },
            _detachVideoEvents() {
                if (!this._eventVideoEl || !this._boundVideoHandlers) return;
                this._eventVideoEl.removeEventListener('ended', this._boundVideoHandlers.ended);
                this._eventVideoEl.removeEventListener('loadedmetadata', this._boundVideoHandlers.loadedmetadata);
                this._eventVideoEl.removeEventListener('play', this._boundVideoHandlers.play);
                this._eventVideoEl.removeEventListener('pause', this._boundVideoHandlers.pause);
                this._eventVideoEl = null;
                this._boundVideoHandlers = null;
            },
            _handleVideoEnded(e) {
                const title = this._cellData.currentVideoTitle;
                console.warn(`%c============'${title}' 播放完成=============`, "color:#4CAF50;font-weight:bold");
                this._isPlaying = false;
                this._clearCheckInterval();
                setTimeout(async () => {
                    const hasMore = await this._playNextVideoInCurrentSection();
                    if (!hasMore) {
                        this.nextUnit();
                    }
                }, 1000);
            },
            _handleVideoLoaded(e) {
                console.log(`%c============视频加载完成=============`, "color:#2196F3");
                if (this.configs.autoplay && !this._isPlaying) {
                    this.play();
                }
            },
            _handleVideoPlay(e) {
                const title = this._cellData.currentVideoTitle;
                console.info(`%c============'${title}' 开始播放=============`, "color:#4CAF50");
                this._isPlaying = true;
                this._stepSwitchPending = false;
                this._consecutiveNextUnit = 0;
                const video = this._videoEl || this._getVideoEl();
                this._guardLastTime = Number(video?.currentTime || 0);
                this._guardLastWallTs = Date.now();
                if (this._delayedNextUnitTimer) {
                    clearTimeout(this._delayedNextUnitTimer);
                    this._delayedNextUnitTimer = null;
                }
            },
            _handleVideoPause(e) {
                if (this._hasVideoQuiz()) {
                    console.log(`%c============视频暂停（互动题弹出）=============`, "color:#E91E63");
                } else {
                    console.log(`%c============视频暂停=============`, "color:#FF9800");
                }
            },
            _bindPageGuards() {
                const resumePlaybackNow = () => this._tryResumePlayback('page-event');
                this._pageGuards = { resumePlaybackNow };
                window.addEventListener('blur', resumePlaybackNow);
                document.addEventListener('visibilitychange', resumePlaybackNow);
            },
            destroy() {
                this._multiTabHandling = false;
                this._contentPageHandling = false;
                this._quizHandling = false;
                this._isPlaying = false;
                this._clearCheckInterval();
                this._detachVideoEvents();
                if (this._delayedNextUnitTimer) clearTimeout(this._delayedNextUnitTimer);
                $(document).off('.xuexitongPlayerV3');
                if (this._pageGuards) {
                    const { resumePlaybackNow } = this._pageGuards;
                    window.removeEventListener('blur', resumePlaybackNow);
                    document.removeEventListener('visibilitychange', resumePlaybackNow);
                    this._pageGuards = null;
                }
            },
        };

        window.app = app;
        window[APP_KEY] = app;

        try {
            app.run();
            app._bindPageGuards();
        } catch (error) {
            console.error("%c脚本运行失败: ", "color:#F44336;font-weight:bold", error.message);
            console.log("请检查是否在正确的课程播放页面，或者页面结构是否再次发生改变。");
        }
    }
})();