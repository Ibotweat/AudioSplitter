
let devices = { inputs: [], outputs: [] };
let routes = [];

// Plugin / Extension system
let loadedThemes = [];   // { id, nom, cssContent, styleEl }
let loadedEffects = [];  // { id, nom, params, createNodes }

// Global Settings
let globalSettings = {
    sampleRate: 'auto',
    latencyHint: 'interactive',
    vuDecay: 0.9,
    theme: 'pro-dark',
    gainMax: 1.5,
    delayMin: -0.5, // Seconds
    delayMax: 1.0,   // Seconds
    eqBands: 5,
    displayMode: 'grid',
    gridCols: '3'
};

// DOM Elements
const routingGrid = document.getElementById('routing-grid');
const addRouteBtn = document.getElementById('add-route');
const template = document.getElementById('routing-card-template');
const navRouting = document.getElementById('nav-routing');
const navSettings = document.getElementById('nav-settings');
const viewRouting = document.getElementById('view-routing');
const viewSettings = document.getElementById('view-settings');
const testOutputsBtn = document.getElementById('test-outputs');
const testModeSelect = document.getElementById('test-mode-select');

let isTesting = false;
let testInterval = null;
let masterVolume = 1.0;
let isMasterMuted = false;
let systemStream = null;
const SYSTEM_DEVICE_ID = 'system-loopback';

/**
 * Route Class to manage individual audio connections
 */
class AudioRoute {
    constructor(id) {
        this.id = id;
        this.inputId = '';
        this.outputId = '';
        this.isActive = true;
        this.gainValue = 1.0;
        this.delayValue = 0.0;
        this.name = `Route ${id + 1}`;
        this.eqValues = new Array(globalSettings.eqBands).fill(0);
        this.activeEffectType = 'equalizer'; // currently displayed effect in pane
        this.effectParams = {};
        this.effectEnabledState = { equalizer: true };

        // Web Audio components
        this.audioContext = null;
        this.source = null;
        this.gainNode = null;
        this.delayNode = null;
        this.eqFilters = [];
        this.customEffectNodes = {}; // effectId → { input, output, setParam, destroy }
        this.analyserInput = null;
        this.analyserOutput = null;
        this.stream = null;

        // Extra audio outputs (secondary AudioContexts)
        this.extraOutputContexts = []; // [{ctx, source, outputId}]
        this.streamDestination = null;  // MediaStreamDestination shared for all extras

        // Channel L/R controls: map of outputId → { L: boolean, R: boolean }
        this.channelStates = {};

        this.initUI();
    }

    initUI() {
        const clone = template.content.cloneNode(true);
        this.card = clone.querySelector('.routing-card');
        this.card.dataset.id = this.id;

        this.titleInput = this.card.querySelector('.editable-title');
        this.titleInput.value = this.name;
        this.titleInput.addEventListener('change', (e) => this.name = e.target.value);

        this.inputSelect = this.card.querySelector('.input-select');
        this.outputSelect = this.card.querySelector('.output-select');
        this.gainSlider = this.card.querySelector('.gain-slider');
        this.gainValDisplay = this.card.querySelector('.gain-val');
        this.delaySlider = this.card.querySelector('.delay-slider');
        this.delayValDisplay = this.card.querySelector('.delay-val');
        this.toggle = this.card.querySelector('.route-toggle');
        this.removeBtn = this.card.querySelector('.btn-remove');

        this.updateDeviceLists();
        this.updateSliderConstraints();

        this.inputSelect.addEventListener('change', () => {
            this.setupAudio();
            this.updateSelectWarning(this.inputSelect, true);
            scheduleAutoSave();
        });
        this.outputSelect.addEventListener('change', () => {
            this.setupAudio();
            this.updateSelectWarning(this.outputSelect, false);
            // Update channel button states when output changes
            setTimeout(() => this.updateChannelButtonStates(), 100);
            scheduleAutoSave();
        });

        this.gainSlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.updateGain(val);
            scheduleAutoSave();
        });

        this.gainSlider.addEventListener('dblclick', () => {
            this.updateGain(1.0);
            this.gainSlider.value = 1.0;
            scheduleAutoSave();
        });

        this.delaySlider.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            this.updateDelay(val);
            scheduleAutoSave();
        });

        this.delaySlider.addEventListener('dblclick', () => {
            this.updateDelay(0.0);
            this.delaySlider.value = 0.0;
            scheduleAutoSave();
        });

        this.toggle.addEventListener('change', (e) => {
            this.isActive = e.target.checked;
            if (this.gainNode && this.audioContext) {
                // Smooth fade instead of full teardown — avoids audio clicks and pipeline reset
                const t = this.audioContext.currentTime;
                if (this.isActive) {
                    this.gainNode.gain.setTargetAtTime(this.gainValue, t, 0.05);
                    if (this.stream) this.stream.getAudioTracks().forEach(tr => { tr.enabled = true; });
                } else {
                    this.gainNode.gain.setTargetAtTime(0, t, 0.05);
                    if (this.stream) this.stream.getAudioTracks().forEach(tr => { tr.enabled = false; });
                }
            } else if (this.isActive) {
                // No context yet — initialize from scratch
                this.setupAudio();
            }
            scheduleAutoSave();
        });

        this.removeBtn.addEventListener('click', () => this.destroy());

        // Effects Trigger wiring
        this.effectsTriggerBtn = this.card.querySelector('.btn-effects-trigger');
        if (this.effectsTriggerBtn) {
            this.effectsTriggerBtn.addEventListener('click', () => {
                openEffectsModal(this);
            });
        }

        // Multi-output: "＋" button
        const addOutputBtn = this.card.querySelector('.btn-add-output');
        if (addOutputBtn) {
            addOutputBtn.addEventListener('click', () => this.addOutputRow());
        }

        routingGrid.appendChild(this.card);
        this.startVisualizer();
        this.setupChannelControls();
    }

    setupChannelControls() {
        // Find all channel buttons in the primary output row
        const primaryRow = this.card.querySelector('.primary-output-row');
        if (!primaryRow) return;

        const channelBtns = primaryRow.querySelectorAll('.channel-btn');
        channelBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const channel = btn.dataset.channel; // 'L' or 'R'
                const outputId = this.outputSelect.value;
                
                if (!this.channelStates[outputId]) {
                    this.channelStates[outputId] = { L: true, R: true };
                }
                
                // Toggle the channel state
                this.channelStates[outputId][channel] = !this.channelStates[outputId][channel];
                
                // Update button appearance
                if (this.channelStates[outputId][channel]) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
                
                // Apply the channel filter to the audio
                this.applyChannelFilter();
                scheduleAutoSave();
            });

            // Restore initial state from channelStates if available
            const outputId = this.outputSelect.value;
            if (this.channelStates[outputId]) {
                const channel = btn.dataset.channel;
                if (this.channelStates[outputId][channel]) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            }
        });

        // Also setup channel buttons for extra output rows if they exist
        const extraRows = this.card.querySelectorAll('.extra-output-row');
        extraRows.forEach((row, idx) => {
            const newChannelBtns = row.querySelectorAll('.channel-btn');
            newChannelBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    const channel = btn.dataset.channel;
                    const sel = row.querySelector('select');
                    const outputId = sel ? sel.value : '';
                    
                    if (!outputId) return;
                    if (!this.channelStates[outputId]) {
                        this.channelStates[outputId] = { L: true, R: true };
                    }
                    
                    this.channelStates[outputId][channel] = !this.channelStates[outputId][channel];
                    
                    if (this.channelStates[outputId][channel]) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                    
                    scheduleAutoSave();
                });

                // Restore initial state
                const sel = row.querySelector('select');
                const outputId = sel ? sel.value : '';
                if (outputId && this.channelStates[outputId]) {
                    const channel = btn.dataset.channel;
                    if (this.channelStates[outputId][channel]) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                }
            });
        });
    }

    updateChannelButtonStates() {
        const primaryRow = this.card.querySelector('.primary-output-row');
        if (!primaryRow) return;

        const outputId = this.outputSelect.value;
        const channelBtns = primaryRow.querySelectorAll('.channel-btn');
        
        // Initialize state if not present
        if (!this.channelStates[outputId]) {
            this.channelStates[outputId] = { L: true, R: true };
        }

        // Update button appearance based on current state
        channelBtns.forEach(btn => {
            const channel = btn.dataset.channel;
            if (this.channelStates[outputId][channel]) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // Apply the filter
        this.applyChannelFilter();
    }

    _restoreChannelButtonAppearance() {
        // Update button appearance for primary output
        const primaryRow = this.card.querySelector('.primary-output-row');
        if (primaryRow) {
            const outputId = this.outputSelect.value;
            if (this.channelStates[outputId]) {
                primaryRow.querySelectorAll('.channel-btn').forEach(btn => {
                    const channel = btn.dataset.channel;
                    if (this.channelStates[outputId][channel]) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                });
            }
        }

        // Update button appearance for extra outputs
        const extraRows = this.card.querySelectorAll('.extra-output-row');
        extraRows.forEach(row => {
            const sel = row.querySelector('select');
            const outputId = sel ? sel.value : '';
            if (outputId && this.channelStates[outputId]) {
                row.querySelectorAll('.channel-btn').forEach(btn => {
                    const channel = btn.dataset.channel;
                    if (this.channelStates[outputId][channel]) {
                        btn.classList.add('active');
                    } else {
                        btn.classList.remove('active');
                    }
                });
            }
        });
    }

    applyChannelFilter() {
        if (!this.audioContext) return;

        // Get the active output ID
        const outputId = this.outputSelect.value;
        if (!outputId || !this.channelStates[outputId]) return;

        const { L, R } = this.channelStates[outputId];

        // Create or modify the stereo panner/splitter
        // We use a simple approach: create gain nodes for each channel
        // If we already have a splitter, we need to disconnect and rebuild
        try {
            // Disconnect the analyserOutput from destination
            this.analyserOutput.disconnect();

            // If both channels are active, route directly
            if (L && R) {
                this.analyserOutput.connect(this.audioContext.destination);
                return;
            }

            // If only L or only R, we need to create a mono output from the stereo
            // Create a merger to combine the selected channel twice (mono output)
            const merger = this.audioContext.createChannelMerger(2);
            const splitter = this.audioContext.createChannelSplitter(2);

            this.analyserOutput.connect(splitter);

            if (L && !R) {
                // Left channel only: merge left+left
                splitter.connect(merger, 0, 0);
                splitter.connect(merger, 0, 1);
            } else if (R && !L) {
                // Right channel only: merge right+right
                splitter.connect(merger, 1, 0);
                splitter.connect(merger, 1, 1);
            } else {
                // Both off: silence
                const silenceGain = this.audioContext.createGain();
                silenceGain.gain.value = 0;
                this.analyserOutput.connect(silenceGain);
                silenceGain.connect(this.audioContext.destination);
                return;
            }

            merger.connect(this.audioContext.destination);
        } catch (e) {
            console.warn('Channel filter error:', e);
        }
    }

    rebuildEQFiltersOnly() {
        if (!this.audioContext) return;
        const freqTable = {
            3:  [200, 1000, 8000],
            5:  [60, 250, 1000, 4000, 14000],
            10: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
        };
        const count = this.eqValues.length || globalSettings.eqBands;
        const freqs = freqTable[count] || freqTable[5];

        if (this.eqValues.length !== count) {
            this.eqValues = new Array(count).fill(0);
        }

        this.eqFilters = freqs.map((freq, i) => {
            const filter = this.audioContext.createBiquadFilter();
            filter.type = i === 0 ? 'lowshelf' : (i === freqs.length - 1 ? 'highshelf' : 'peaking');
            filter.frequency.value = freq;
            filter.Q.value = 1.2;
            filter.gain.value = this.eqValues[i] || 0;
            return filter;
        });

        for (let i = 0; i < this.eqFilters.length - 1; i++) {
            this.eqFilters[i].connect(this.eqFilters[i + 1]);
        }
    }

    // Create/recreate the audio node for a single effect by id
    setupCustomEffect(effectId) {
        if (effectId === 'equalizer' || !effectId) return;
        if (!this.audioContext) return;

        // Destroy existing node for this effect if any
        const existing = this.customEffectNodes[effectId];
        if (existing) {
            try { existing.output.disconnect(); } catch(e){}
            if (typeof existing.destroy === 'function') try { existing.destroy(); } catch(e){}
            delete this.customEffectNodes[effectId];
        }

        const effectDef = loadedEffects.find(e => e.id === effectId);
        if (!effectDef) return;

        try {
            const node = effectDef.createNodes(this.audioContext);
            this.customEffectNodes[effectId] = node;

            // Apply any saved parameters for this effect
            if (!this.effectParams[effectId]) {
                this.effectParams[effectId] = {};
            }
            const params = this.effectParams[effectId];
            if (effectDef.params) {
                effectDef.params.forEach(param => {
                    const paramKey = param.id || param.name;
                    const val = params[paramKey] !== undefined ? params[paramKey] : param.default;
                    params[paramKey] = val;
                    if (node && typeof node.setParam === 'function') {
                        try {
                            node.setParam(paramKey, val);
                        } catch (err) {}
                    }
                });
            }
        } catch(err) {
            console.error(`Failed to setup custom effect ${effectId}:`, err);
        }
    }

    connectEffectsChain() {
        if (!this.audioContext) return;

        // Disconnect delayNode and EQ/custom filters to avoid duplicate/parallel routing
        if (this.delayNode) {
            try { this.delayNode.disconnect(); } catch(e){}
        }
        if (this.eqFilters) {
            this.eqFilters.forEach(f => {
                try { f.disconnect(); } catch(e){}
            });
        }
        Object.values(this.customEffectNodes).forEach(node => {
            if (node && node.output) {
                try { node.output.disconnect(); } catch(e){}
            }
        });

        // Build chain: delayNode → [EQ] → [effect1] → [effect2] → ... → gainNode
        let current = this.delayNode;
        if (!current) return;

        // 1. EQ (always first)
        const eqEnabled = this.effectEnabledState && this.effectEnabledState['equalizer'] !== false;
        if (eqEnabled && this.eqFilters && this.eqFilters.length > 0) {
            current.connect(this.eqFilters[0]);
            for (let i = 0; i < this.eqFilters.length - 1; i++) {
                this.eqFilters[i].connect(this.eqFilters[i + 1]);
            }
            current = this.eqFilters[this.eqFilters.length - 1];
        }

        // 2. Custom effects in loadedEffects order
        for (const eff of loadedEffects) {
            const enabled = this.effectEnabledState && this.effectEnabledState[eff.id] !== false;
            const node = this.customEffectNodes[eff.id];
            if (enabled && node && node.input && node.output) {
                current.connect(node.input);
                current = node.output;
            }
        }

        // 3. Final output
        current.connect(this.gainNode);
    }

    // setEffect only changes which effect is DISPLAYED in the modal pane
    setEffect(effectId) {
        this.activeEffectType = effectId;
        // Ensure node exists for custom effects (lazy init)
        if (effectId !== 'equalizer' && !this.customEffectNodes[effectId]) {
            this.setupCustomEffect(effectId);
            this.connectEffectsChain();
        }
    }

    updateEQBands(count) {
        this.eqValues = new Array(count).fill(0);
        if (this.audioContext) {
            this.rebuildEQFiltersOnly();
            this.connectEffectsChain();
        }
    }

    updateDeviceLists() {
        const currentInput = this.inputSelect.value;
        const currentOutput = this.outputSelect.value;

        // Helper: check if a device ID exists in the available devices array
        const isDeviceAvailable = (deviceId, deviceArray) => {
            if (deviceId === SYSTEM_DEVICE_ID) return true; // System audio is virtual, always "available"
            return deviceArray.some(d => d.deviceId === deviceId);
        };

        // Helper: create an option element with styling for missing devices
        const createDeviceOption = (deviceId, label, isMissing = false) => {
            const opt = document.createElement('option');
            opt.value = deviceId;
            if (isMissing) {
                opt.text = `${label} (Déconnecté)`;
                opt.style.color = '#ef4444'; // Red color
            } else {
                opt.text = label;
            }
            return opt;
        };

        this.inputSelect.innerHTML = '<option value="">Sélectionner une entrée...</option>';
        devices.inputs.forEach(d => {
            const label = d.label || `Entrée ${d.deviceId.slice(0, 5)}`;
            this.inputSelect.appendChild(createDeviceOption(d.deviceId, label, false));
        });

        // If current input was saved but is now missing, add it as disabled
        if (currentInput && !isDeviceAvailable(currentInput, devices.inputs) && currentInput !== SYSTEM_DEVICE_ID) {
            const missingLabel = `Entrée ${currentInput.slice(0, 5)}`;
            this.inputSelect.appendChild(createDeviceOption(currentInput, missingLabel, true));
        }

        // Add System Audio option
        const sysOpt = document.createElement('option');
        sysOpt.value = SYSTEM_DEVICE_ID;
        sysOpt.text = '🔊 Audio Système (Loopback)';
        this.inputSelect.appendChild(sysOpt);

        this.outputSelect.innerHTML = '<option value="">Sélectionner une sortie...</option>';
        devices.outputs.forEach(d => {
            const label = d.label || `Sortie ${d.deviceId.slice(0, 5)}`;
            this.outputSelect.appendChild(createDeviceOption(d.deviceId, label, false));
        });

        // If current output was saved but is now missing, add it as disabled
        if (currentOutput && !isDeviceAvailable(currentOutput, devices.outputs)) {
            const missingLabel = `Sortie ${currentOutput.slice(0, 5)}`;
            this.outputSelect.appendChild(createDeviceOption(currentOutput, missingLabel, true));
        }

        this.inputSelect.value = currentInput;
        this.outputSelect.value = currentOutput;

        this.updateSelectWarning(this.inputSelect, true);
        this.updateSelectWarning(this.outputSelect, false);

        // Also refresh any extra output selects
        this.card.querySelectorAll('.extra-output-row select').forEach(sel => {
            const prev = sel.value;
            sel.innerHTML = '<option value="">Sélectionner une sortie...</option>';
            devices.outputs.forEach(d => {
                const label = d.label || `Sortie ${d.deviceId.slice(0, 5)}`;
                sel.appendChild(createDeviceOption(d.deviceId, label, false));
            });
            // If extra output was missing, add it too
            if (prev && !isDeviceAvailable(prev, devices.outputs)) {
                const missingLabel = `Sortie ${prev.slice(0, 5)}`;
                sel.appendChild(createDeviceOption(prev, missingLabel, true));
            }
            sel.value = prev;
            this.updateSelectWarning(sel, false);
        });
    }

    updateSelectWarning(sel, isInput) {
        const wrapper = sel.closest('.select-wrapper');
        if (!wrapper) return;
        let warningWrapper = wrapper.querySelector('.warning-icon-wrapper');
        if (!warningWrapper) {
            warningWrapper = document.createElement('div');
            warningWrapper.className = 'warning-icon-wrapper';
            wrapper.appendChild(warningWrapper);
        }

        const deviceId = sel.value;
        const deviceArray = isInput ? devices.inputs : devices.outputs;
        const isSystem = isInput && deviceId === SYSTEM_DEVICE_ID;
        const isEmpty = !deviceId;
        
        // A device is missing if it has a value, is not system audio, and is not in the list of available devices
        const isMissing = !isEmpty && !isSystem && !deviceArray.some(d => d.deviceId === deviceId);

        if (isMissing) {
            warningWrapper.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--danger);">
                    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
            `;
            warningWrapper.style.display = 'flex';
            sel.style.color = '#ef4444'; // Make select text red when missing
        } else {
            warningWrapper.innerHTML = '';
            warningWrapper.style.display = 'none';
            sel.style.color = ''; // Restore default color
        }
    }

    updateGain(val) {
        this.gainValue = val;
        const db = 20 * Math.log10(val || 0.0001);
        this.gainValDisplay.innerText = `${db.toFixed(1)} dB`;
        if (this.gainNode) {
            const effectiveVolume = isMasterMuted ? 0 : masterVolume;
            this.gainNode.gain.setTargetAtTime(val * effectiveVolume, this.audioContext.currentTime, 0.02);
        }
    }

    updateDelay(val) {
        this.delayValue = val;
        this.delayValDisplay.innerText = `${(val * 1000).toFixed(0)} ms`;
        syncAllDelays();
    }

    updateSliderConstraints() {
        this.gainSlider.max = globalSettings.gainMax;
        this.delaySlider.min = globalSettings.delayMin;
        this.delaySlider.max = globalSettings.delayMax;
        
        // Ensure current values are within new bounds
        if (this.gainValue > globalSettings.gainMax) {
            this.gainValue = globalSettings.gainMax;
            this.gainSlider.value = this.gainValue;
        }
        if (this.delayValue < globalSettings.delayMin) {
            this.delayValue = globalSettings.delayMin;
            this.delaySlider.value = this.delayValue;
        }
        if (this.delayValue > globalSettings.delayMax) {
            this.delayValue = globalSettings.delayMax;
            this.delaySlider.value = this.delayValue;
        }
        this.delayValDisplay.innerText = `${(this.delayValue * 1000).toFixed(0)} ms`;
    }

    async setupAudio() {
        // Cleanup existing
        this.cleanupAudio();

        this.inputId = this.inputSelect.value;
        this.outputId = this.outputSelect.value;

        // Auto-name if it's the default name
        if (this.inputId) {
            const device = devices.inputs.find(d => d.deviceId === this.inputId);
            if (device && (this.name.startsWith('Route ') || this.name === 'Route sans nom')) {
                this.name = device.label || 'Entrée';
                this.titleInput.value = this.name;
            }
        }

        try {
            console.log(`Initialisation audio pour Route ${this.id}...`);
            console.log(`Entrée demandée: ${this.inputId}, Sortie demandée: ${this.outputId}`);

            // --- STEP 1: Get the stream FIRST to discover the device's native sample rate ---
            if (this.inputId === SYSTEM_DEVICE_ID) {
                if (!systemStream) {
                    await this.initSystemCapture();
                }
                this.stream = systemStream.clone();
            } else {
                this.stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        deviceId: this.inputId ? { exact: this.inputId } : undefined,
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false
                    }
                });
            }

            const tracks = this.stream.getAudioTracks();
            if (tracks.length === 0) {
                throw new Error('Aucune piste audio disponible sur ce périphérique d\'entrée.');
            }
            tracks[0].enabled = true;
            const nativeSampleRate = tracks[0].getSettings().sampleRate;
            console.log(`Stream obtenu: ${tracks.length} piste(s) audio. Appareil: ${tracks[0].label}, SampleRate natif: ${nativeSampleRate}Hz`);

            // --- STEP 2: Create AudioContext matching the stream's native rate to prevent silent resampling ---
            const ctxOptions = {
                latencyHint: globalSettings.latencyHint
            };
            if (globalSettings.sampleRate && globalSettings.sampleRate !== 'auto') {
                // User forced a specific rate
                ctxOptions.sampleRate = parseInt(globalSettings.sampleRate);
            } else if (nativeSampleRate) {
                // Auto-match the device's reported sample rate — critical for avoiding silence
                ctxOptions.sampleRate = nativeSampleRate;
            }
            this.audioContext = new AudioContext(ctxOptions);
            console.log(`AudioContext créé. Fréquence: ${this.audioContext.sampleRate}Hz, État initial: ${this.audioContext.state}`);

            // CRITICAL: Resume AudioContext — Chromium suspends it by default (Autoplay Policy)
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
                console.log(`AudioContext resumé. Nouvel état: ${this.audioContext.state}`);
            }

            // --- STEP 3: Build the audio graph ---
            this.source = this.audioContext.createMediaStreamSource(this.stream);
            
            // Analysers for VU meters
            this.analyserInput = this.audioContext.createAnalyser();
            this.analyserInput.fftSize = 256;
            
            this.delayNode = this.audioContext.createDelay(10.0); // Max 10s delay
            
            this.gainNode = this.audioContext.createGain();
            const effectiveVolume = isMasterMuted ? 0 : masterVolume;
            this.gainNode.gain.value = this.gainValue * effectiveVolume;

            this.analyserOutput = this.audioContext.createAnalyser();
            this.analyserOutput.fftSize = 256;

            // Route: Source -> AnalyserIn -> Delay -> Effects Chain -> Gain -> AnalyserOut -> Destination
            this.source.connect(this.analyserInput);
            this.analyserInput.connect(this.delayNode);

            // Rebuild EQ filters
            this.rebuildEQFiltersOnly();

            // Initialize nodes for ALL enabled custom effects
            this.customEffectNodes = {};
            for (const eff of loadedEffects) {
                const enabled = this.effectEnabledState && this.effectEnabledState[eff.id] !== false;
                if (enabled) this.setupCustomEffect(eff.id);
            }

            // Connect the effects chain
            this.connectEffectsChain();

            this.gainNode.connect(this.analyserOutput);
            this.analyserOutput.connect(this.audioContext.destination);

            // Initialize channel L/R state for main output
            if (!this.channelStates[this.outputId]) {
                this.channelStates[this.outputId] = { L: true, R: true };
            }

            syncAllDelays(); // Set initial delay value correctly

            // --- STEP 4: Set the output device LAST (non-fatal) ---
            if (this.outputId && this.outputId !== 'default' && typeof this.audioContext.setSinkId === 'function') {
                try {
                    await this.audioContext.setSinkId(this.outputId);
                    console.log(`Redirection de sortie réussie vers: ${this.outputId}`);
                } catch (sinkErr) {
                    console.error("Échec setSinkId (non-fatal):", sinkErr);
                    showToast(`⚠️ Sortie audio non supportée ou refusée. Son envoyé vers le périphérique par défaut.`);
                }
            }

            console.log(`Route ${this.id} initialisée avec succès.`);
        } catch (err) {
            console.error('Erreur d\'initialisation audio de la route:', err);
            showToast(`❌ Erreur audio: ${err.message}`);
        }
    }

    async initSystemCapture() {
        try {
            const sources = await window.electron.getSources();
            // Try to find the primary screen
            const screenSource = sources.find(s => s.name === 'Entire Screen' || s.name === 'Screen 1' || s.id.startsWith('screen:'));
            
            if (!screenSource) {
                throw new Error("Impossible de trouver une source d'écran pour l'audio.");
            }

            systemStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: screenSource.id
                    }
                },
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: screenSource.id,
                        maxWidth: 1,
                        maxHeight: 1
                    }
                }
            });

            // Stop video tracks immediately — they were only needed to satisfy the
            // getUserMedia API constraint. Leaving them alive causes video_frame_pool
            // to spam "Failed to create a video frame" errors at ~20fps.
            systemStream.getVideoTracks().forEach(t => t.stop());

        } catch (err) {
            console.error('Erreur capture système:', err);
            systemStream = null;
            throw err;
        }
    }

    cleanupAudio() {
        if (this.stream) {
            this.stream.getTracks().forEach(t => t.stop());
            this.stream = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        // Destroy all custom effect nodes
        Object.values(this.customEffectNodes || {}).forEach(node => {
            try { node.output.disconnect(); } catch(e){}
            if (typeof node.destroy === 'function') try { node.destroy(); } catch(e){}
        });
        this.customEffectNodes = {};
        // Destroy extra output contexts
        for (const extra of this.extraOutputContexts) {
            try { extra.source.disconnect(); } catch(e){}
            try { extra.ctx.close(); } catch(e){}
        }
        this.extraOutputContexts = [];
        this.streamDestination = null;
        this.source = null;
        this.gainNode = null;
        this.delayNode = null;
        this.eqFilters = [];
        this.analyserInput = null;
        this.analyserOutput = null;
        // Cleanup channel L/R nodes
        try { if (this._channelSplitter) this._channelSplitter.disconnect(); } catch(e){}
        try { if (this._gainL) this._gainL.disconnect(); } catch(e){}
        try { if (this._gainR) this._gainR.disconnect(); } catch(e){}
        try { if (this._channelMerger) this._channelMerger.disconnect(); } catch(e){}
        this._channelSplitter = null;
        this._gainL = null;
        this._gainR = null;
        this._channelMerger = null;
    }

    startVisualizer() {
        const inBars = this.card.querySelectorAll('.input-vu .vu-bar');
        const outBars = this.card.querySelectorAll('.output-vu .vu-bar');
        
        let silenceCount = 0;
        let warningShown = false;

        const update = () => {
            if (!this.card) return; // Destroyed

            if (this.analyserInput) {
                const data = new Uint8Array(this.analyserInput.frequencyBinCount);
                this.analyserInput.getByteFrequencyData(data);
                const avg = data.reduce((a, b) => a + b, 0) / data.length;
                const level = Math.min(100, (avg / 128) * 100);
                
                // Track consecutive frames of absolute silence (avg === 0)
                if (avg === 0) {
                    silenceCount++;
                    if (silenceCount > 180 && !warningShown && this.isActive) {
                        console.warn(`[Route ${this.id}] Silence total détecté. Si c'est anormal, vérifiez les paramètres de Confidentialité de Windows (Autoriser les applications de bureau à accéder à votre microphone) ou le bouton physique Mute de votre micro.`);
                        warningShown = true;
                    }
                } else {
                    silenceCount = 0;
                    warningShown = false;
                }

                // In list-mode the bars are vertical (height%), in grid they are horizontal (width%)
                const isListMode = routingGrid.classList.contains('list-mode');
                const vuProp = isListMode ? 'height' : 'width';

                // Apply decay from settings
                const currentIn = parseFloat(inBars[0].style[vuProp]) || 0;
                const targetIn = level;
                const newIn = targetIn > currentIn ? targetIn : currentIn * globalSettings.vuDecay;

                inBars[0].style[vuProp] = `${newIn}%`;
                inBars[1].style[vuProp] = `${newIn}%`;
            } else {
                const vuProp = routingGrid.classList.contains('list-mode') ? 'height' : 'width';
                inBars[0].style[vuProp] = '0%';
                inBars[1].style[vuProp] = '0%';
            }

            if (this.analyserOutput) {
                const data = new Uint8Array(this.analyserOutput.frequencyBinCount);
                this.analyserOutput.getByteFrequencyData(data);
                const avg = data.reduce((a, b) => a + b, 0) / data.length;
                const level = Math.min(100, (avg / 128) * 100);

                const isListMode = routingGrid.classList.contains('list-mode');
                const vuProp = isListMode ? 'height' : 'width';

                // Apply decay from settings
                const currentOut = parseFloat(outBars[0].style[vuProp]) || 0;
                const targetOut = level;
                const newOut = targetOut > currentOut ? targetOut : currentOut * globalSettings.vuDecay;

                outBars[0].style[vuProp] = `${newOut}%`;
                outBars[1].style[vuProp] = `${newOut}%`;
            } else {
                const vuProp = routingGrid.classList.contains('list-mode') ? 'height' : 'width';
                outBars[0].style[vuProp] = '0%';
                outBars[1].style[vuProp] = '0%';
            }

            requestAnimationFrame(update);
        };
        update();
    }

    destroy() {
        this.cleanupAudio();
        this.card.remove();
        routes = routes.filter(r => r !== this);
        updateEmptyState();
        this.card = null;
    }

    // ---------------------------------------------------------------
    // Multi-output helpers
    // ---------------------------------------------------------------
    /** Ensure there's a MediaStreamDestination connected to gainNode */
    _ensureStreamDestination() {
        if (!this.streamDestination && this.gainNode && this.audioContext) {
            this.streamDestination = this.audioContext.createMediaStreamDestination();
            this.gainNode.connect(this.streamDestination);
        }
    }

    async addExtraOutput(outputId) {
        if (!this.audioContext || !outputId) return null;
        this._ensureStreamDestination();
        try {
            const ctx = new AudioContext({ sampleRate: this.audioContext.sampleRate, latencyHint: 'interactive' });
            if (typeof ctx.setSinkId === 'function' && outputId !== 'default') {
                await ctx.setSinkId(outputId);
            }
            const source = ctx.createMediaStreamSource(this.streamDestination.stream);
            source.connect(ctx.destination);
            const entry = { ctx, source, outputId };
            this.extraOutputContexts.push(entry);
            return entry;
        } catch(err) {
            console.error('addExtraOutput failed:', err);
            return null;
        }
    }

    async removeExtraOutput(entry) {
        const idx = this.extraOutputContexts.indexOf(entry);
        if (idx < 0) return;
        try { entry.source.disconnect(); } catch(e){}
        try { await entry.ctx.close(); } catch(e){}
        this.extraOutputContexts.splice(idx, 1);
        if (this.extraOutputContexts.length === 0 && this.streamDestination) {
            try { this.gainNode.disconnect(this.streamDestination); } catch(e){}
            this.streamDestination = null;
        }
    }

    /** Adds a UI row for an extra output and wires it up */
    addOutputRow(existingOutputId = '') {
        const outputsList = this.card.querySelector('.outputs-list');
        if (!outputsList) return;

        const row = document.createElement('div');
        row.className = 'output-row extra-output-row';

        const sel = document.createElement('select');
        sel.innerHTML = '<option value="">Sélectionner une sortie...</option>';
        devices.outputs.forEach(d => {
            const opt = document.createElement('option');
            opt.value = d.deviceId;
            opt.text = d.label || `Sortie ${d.deviceId.slice(0, 5)}`;
            sel.appendChild(opt);
        });

        // If extra output was missing, add it to options
        if (existingOutputId && !devices.outputs.some(d => d.deviceId === existingOutputId)) {
            const opt = document.createElement('option');
            opt.value = existingOutputId;
            opt.text = `Sortie ${existingOutputId.slice(0, 5)} (Déconnecté)`;
            opt.style.color = '#ef4444';
            sel.appendChild(opt);
        }

        if (existingOutputId) sel.value = existingOutputId;

        // Create channel L/R buttons
        const channelControls = document.createElement('div');
        channelControls.className = 'channel-controls';

        const btnL = document.createElement('button');
        btnL.className = 'channel-btn active';
        btnL.dataset.channel = 'L';
        btnL.title = 'Canal Gauche';
        btnL.textContent = 'L';

        const btnR = document.createElement('button');
        btnR.className = 'channel-btn active';
        btnR.dataset.channel = 'R';
        btnR.title = 'Canal Droit';
        btnR.textContent = 'R';

        channelControls.appendChild(btnL);
        channelControls.appendChild(btnR);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn-remove-output';
        removeBtn.title = 'Supprimer cette sortie';
        removeBtn.textContent = '−';

        let entry = null;

        const applyOutput = async (outputId) => {
            if (entry) { await this.removeExtraOutput(entry); entry = null; }
            if (outputId) { entry = await this.addExtraOutput(outputId); }
            scheduleAutoSave();
        };

        sel.addEventListener('change', () => {
            applyOutput(sel.value);
            this.updateSelectWarning(sel, false);
        });

        removeBtn.addEventListener('click', async () => {
            if (entry) { await this.removeExtraOutput(entry); }
            row.remove();
            scheduleAutoSave();
        });

        const selectWrapper = document.createElement('div');
        selectWrapper.className = 'select-wrapper';
        selectWrapper.appendChild(sel);

        const warningWrapper = document.createElement('div');
        warningWrapper.className = 'warning-icon-wrapper';
        warningWrapper.style.display = 'none';
        selectWrapper.appendChild(warningWrapper);

        selectWrapper.appendChild(channelControls);

        row.appendChild(selectWrapper);
        row.appendChild(removeBtn);
        outputsList.appendChild(row);

        // Re-setup channel controls to bind new buttons
        this.setupChannelControls();

        // If pre-filled (config restore), connect immediately
        if (existingOutputId && this.audioContext) {
            applyOutput(existingOutputId);
        } else if (existingOutputId) {
            // Will connect once setupAudio runs — store for deferred init
            row._pendingOutputId = existingOutputId;
        }

        this.updateSelectWarning(sel, false);
    }}

function updateEmptyState() {
    const empty = document.querySelector('.empty-state');
    if (empty) {
        if (routes.length > 0) {
            empty.style.display = 'none';
        } else {
            empty.style.display = 'block';
        }
    }
}

/**
 * Device discovery
 */
async function refreshDevices() {
    try {
        // Request permission first to get labels, but release the stream immediately
        try {
            const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            tempStream.getTracks().forEach(t => t.stop());
        } catch (permErr) {
            console.warn('Microphone permission request failed (non-fatal):', permErr);
        }
        
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        devices.inputs = allDevices.filter(d => d.kind === 'audioinput');
        devices.outputs = allDevices.filter(d => d.kind === 'audiooutput');

        console.log('Appareils détectés:', devices);

        // Check if driver/virtual audio device is installed.
        // We check ALL devices (inputs + outputs) because VB-Audio appears as:
        //   - input: "CABLE Output (VB-Audio Virtual Cable)"
        //   - output: "CABLE Input (VB-Audio Virtual Cable)"
        // Also support Voicemeeter, our own AudioSplitter branding, and a manual override.
        const keywords = ['CABLE', 'VB-Audio', 'Voicemeeter', 'AudioSplitter'];
        const allDetected = [...devices.inputs, ...devices.outputs];
        const isDriverInstalled =
            localStorage.getItem('as-driver-dismissed') === '1' ||
            allDetected.some(d => keywords.some(k => d.label.includes(k)));

        const promoCard = document.getElementById('driver-promo');
        const installedCard = document.getElementById('driver-installed-status');

        if (isDriverInstalled) {
            if (promoCard) promoCard.style.display = 'none';
            if (installedCard) installedCard.style.display = 'block';
        } else {
            if (promoCard) promoCard.style.display = 'block';
            if (installedCard) installedCard.style.display = 'none';

            // Add a "I already have it" link if not already present
            if (promoCard && !promoCard.querySelector('#btn-already-installed')) {
                const alreadyBtn = document.createElement('button');
                alreadyBtn.id = 'btn-already-installed';
                alreadyBtn.textContent = "J'ai déjà un driver installé";
                alreadyBtn.style.cssText = 'margin-top:10px;background:transparent;border:none;color:var(--text-dim);font-size:0.78rem;cursor:pointer;text-decoration:underline;';
                alreadyBtn.onclick = () => {
                    localStorage.setItem('as-driver-dismissed', '1');
                    if (promoCard) promoCard.style.display = 'none';
                    if (installedCard) installedCard.style.display = 'block';
                };
                promoCard.appendChild(alreadyBtn);
            }

            const installBtn = document.getElementById('btn-install-driver');
            if (installBtn) {
                installBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 8px;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> Installer le Pilote Core';
                installBtn.disabled = false;
            }
        }

        // Update all active route selects
        routes.forEach(r => r.updateDeviceLists());
    } catch (err) {
        console.error('Erreur détection appareils:', err);
    }
}

function syncAllDelays() {
    // Find the minimum delay value among all active routes
    const activeRoutes = routes.filter(r => r.isActive && r.delayNode);
    if (activeRoutes.length === 0) return;

    const minRawDelay = Math.min(...activeRoutes.map(r => Number(r.delayValue) || 0));
    
    // The "compensation" is only needed if someone is negative
    // We offset everyone so that the most negative route is at 0ms
    const offset = minRawDelay < 0 ? -minRawDelay : 0;

    activeRoutes.forEach(route => {
        const val = Number(route.delayValue) || 0;
        const actualDelay = val + offset;
        if (route.audioContext && route.delayNode && route.delayNode.delayTime) {
            route.delayNode.delayTime.setTargetAtTime(actualDelay, route.audioContext.currentTime, 0.05);
        }
    });
}

// Navigation Logic
navRouting.addEventListener('click', () => {
    navRouting.classList.add('active');
    navSettings.classList.remove('active');
    viewRouting.classList.add('active');
    viewSettings.classList.remove('active');
    
    navRouting.classList.remove('animate-routing');
    void navRouting.offsetWidth; // Force reflow to restart animation
    navRouting.classList.add('animate-routing');
});
navRouting.addEventListener('animationend', () => {
    navRouting.classList.remove('animate-routing');
});

navSettings.addEventListener('click', () => {
    navSettings.classList.add('active');
    navRouting.classList.remove('active');
    viewSettings.classList.add('active');
    viewRouting.classList.remove('active');
    
    navSettings.classList.remove('animate-settings');
    void navSettings.offsetWidth; // Force reflow to restart animation
    navSettings.classList.add('animate-settings');
});
navSettings.addEventListener('animationend', () => {
    navSettings.classList.remove('animate-settings');
});

// Driver Installation Logic
const installDriverBtn = document.getElementById('btn-install-driver');
installDriverBtn.addEventListener('click', async () => {
    installDriverBtn.disabled = true;
    installDriverBtn.innerHTML = '⌛ Installation en cours...';
    
    try {
        const result = await window.electron.installDriver();
        if (result.success) {
            alert("L'installateur a été lancé ! Veuillez suivre les étapes à l'écran, puis redémarrez votre PC.");
            installDriverBtn.innerHTML = '✅ Installateur lancé';
        } else {
            alert(`Erreur : ${result.error}`);
            installDriverBtn.disabled = false;
            installDriverBtn.innerHTML = 'Installer le Pilote Core';
        }
    } catch (err) {
        console.error('Erreur installateur:', err);
        installDriverBtn.disabled = false;
        installDriverBtn.innerHTML = 'Installer le Pilote Core';
    }
});

// Driver Uninstallation Logic
const uninstallDriverBtn = document.getElementById('btn-uninstall-driver');
if (uninstallDriverBtn) {
    uninstallDriverBtn.addEventListener('click', async () => {
        uninstallDriverBtn.disabled = true;
        uninstallDriverBtn.innerHTML = '⌛ Désinstallation...';
        
        try {
            const result = await window.electron.uninstallDriver();
            if (result.success) {
                alert("Le désinstallateur a été lancé ! Veuillez suivre les étapes pour désinstaller le pilote, puis redémarrez votre PC.");
                uninstallDriverBtn.innerHTML = '✅ Désinstallateur lancé';
            } else {
                alert(`Erreur : ${result.error}`);
                uninstallDriverBtn.disabled = false;
                uninstallDriverBtn.innerHTML = 'Désinstaller le Pilote';
            }
        } catch (err) {
            console.error('Erreur désinstallation:', err);
            uninstallDriverBtn.disabled = false;
            uninstallDriverBtn.innerHTML = 'Désinstaller le Pilote';
        }
    });
}

// Test Melody Logic
testOutputsBtn.addEventListener('click', () => {
    if (isTesting) {
        stopTest();
    } else {
        startTest();
    }
});

function startTest() {
    isTesting = true;
    testOutputsBtn.classList.add('active');
    testOutputsBtn.closest('.split-button-container')?.classList.add('active-test');
    testOutputsBtn.querySelector('#test-outputs-label') && (testOutputsBtn.querySelector('#test-outputs-label').innerText = 'Arrêter Test');

    const mode = testModeSelect ? testModeSelect.value : 'melody';

    // helper: play a tone through the route's processing chain (if available)
    function playTestToneOnRoute(route, freq, durationSec = 0.1, opts = {}) {
        try {
            if (!route.audioContext) return;
            const ctx = route.audioContext;
            const osc = ctx.createOscillator();
            const env = ctx.createGain();

            osc.type = opts.type || 'sine';
            osc.frequency.setValueAtTime(freq, ctx.currentTime);

            const peak = (typeof opts.peak === 'number') ? opts.peak : 0.2;
            env.gain.setValueAtTime(0, ctx.currentTime);
            env.gain.linearRampToValueAtTime(peak, ctx.currentTime + 0.005);
            env.gain.linearRampToValueAtTime(0, ctx.currentTime + durationSec);

            osc.connect(env);

            // If the route has an analyserInput (i.e. normal chain exists), feed into it so effects apply
            if (route.analyserInput) {
                env.connect(route.analyserInput);
            } else if (route.delayNode) {
                // fallback: connect to delayNode if analyser missing
                env.connect(route.delayNode);
            } else if (route.gainNode) {
                env.connect(route.gainNode);
            } else {
                // ultimate fallback
                env.connect(ctx.destination);
            }

            osc.start();
            osc.stop(ctx.currentTime + durationSec);

            // Cleanup after stop
            const cleanupMs = Math.ceil(durationSec * 1000) + 150;
            setTimeout(() => {
                try { env.disconnect(); } catch(e){}
                try { osc.disconnect(); } catch(e){}
            }, cleanupMs);
        } catch (e) {
            console.warn('playTestToneOnRoute error', e);
        }
    }

    if (mode === 'beats') {
        const bpm = 100;
        const intervalMs = Math.round(60000 / bpm); // 600ms
        testInterval = setInterval(() => {
            routes.forEach(route => {
                if (route.audioContext && route.isActive) {
                    // short percussive click routed through the chain
                    playTestToneOnRoute(route, 1200, 0.09, { type: 'square', peak: 0.28 });
                }
            });
        }, intervalMs);
    } else {
        let noteIndex = 0;
        const notes = [440, 554.37, 659.25, 880]; // A4, C#5, E5, A5
        testInterval = setInterval(() => {
            const freq = notes[noteIndex % notes.length];
            routes.forEach(route => {
                if (route.audioContext && route.isActive) {
                    playTestToneOnRoute(route, freq, 0.25, { type: 'sine', peak: 0.2 });
                }
            });
            noteIndex++;
        }, 400);
    }
}

function stopTest() {
    isTesting = false;
    clearInterval(testInterval);
    testOutputsBtn.classList.remove('active');
    testOutputsBtn.closest('.split-button-container')?.classList.remove('active-test');
    testOutputsBtn.querySelector('#test-outputs-label') && (testOutputsBtn.querySelector('#test-outputs-label').innerText = 'Tester Sorties');
}

// Settings Handlers
function applyDisplayMode(mode) {
    globalSettings.displayMode = mode;
    const el = document.getElementById('setting-display-mode');
    if (el) el.value = mode;

    if (mode === 'list') {
        routingGrid.classList.add('list-mode');
        applyListModeToggles();
    } else {
        routingGrid.classList.remove('list-mode');
        restoreGridModeToggles();
    }
}

function applyGridCols(cols) {
    globalSettings.gridCols = cols;
    const el = document.getElementById('setting-grid-cols');
    if (el) el.value = cols;

    routingGrid.className = 'routing-grid';
    if (cols === 'auto') {
        routingGrid.classList.add('cols-auto');
    } else {
        routingGrid.classList.add(`cols-${cols}`);
    }
    // Restore list-mode class if it was set (since setting routingGrid.className clears all classes)
    if (globalSettings.displayMode === 'list') {
        routingGrid.classList.add('list-mode');
    }
}

document.getElementById('setting-sample-rate').addEventListener('change', (e) => {
    globalSettings.sampleRate = e.target.value;
    console.log('Sample rate updated:', globalSettings.sampleRate);
    scheduleAutoSave();
});

document.getElementById('setting-latency').addEventListener('change', (e) => {
    globalSettings.latencyHint = e.target.value;
    scheduleAutoSave();
});

document.getElementById('setting-vu-speed').addEventListener('input', (e) => {
    globalSettings.vuDecay = parseFloat(e.target.value);
    scheduleAutoSave();
});

document.getElementById('setting-display-mode').addEventListener('change', (e) => {
    applyDisplayMode(e.target.value);
    scheduleAutoSave();
});

/** Move .toggle-control out of .card-footer → directly onto .routing-card */
function applyListModeToggles() {
    routingGrid.querySelectorAll('.routing-card').forEach(card => {
        const toggle = card.querySelector('.card-footer .toggle-control');
        if (toggle && !toggle.dataset.movedToCard) {
            card.appendChild(toggle);
            toggle.dataset.movedToCard = '1';
        }
    });
}

/** Restore .toggle-control back inside .card-footer */
function restoreGridModeToggles() {
    routingGrid.querySelectorAll('.routing-card').forEach(card => {
        const toggle = card.querySelector('.toggle-control[data-moved-to-card]');
        const footer = card.querySelector('.card-footer');
        if (toggle && footer) {
            footer.appendChild(toggle);
            delete toggle.dataset.movedToCard;
        }
    });
}

document.getElementById('setting-grid-cols').addEventListener('change', (e) => {
    applyGridCols(e.target.value);
    scheduleAutoSave();
});

document.getElementById('setting-gain-max').addEventListener('change', (e) => {
    globalSettings.gainMax = parseFloat(e.target.value);
    routes.forEach(r => r.updateSliderConstraints());
    scheduleAutoSave();
});

document.getElementById('setting-delay-min').addEventListener('change', (e) => {
    globalSettings.delayMin = parseFloat(e.target.value) / 1000;
    routes.forEach(r => r.updateSliderConstraints());
    syncAllDelays();
    scheduleAutoSave();
});

document.getElementById('setting-delay-max').addEventListener('change', (e) => {
    globalSettings.delayMax = parseFloat(e.target.value) / 1000;
    routes.forEach(r => r.updateSliderConstraints());
    syncAllDelays();
    scheduleAutoSave();
});

// EQ band count is now changed from inside the Effects modal (below the EQ)

document.getElementById('setting-theme').addEventListener('change', (e) => {
    const theme = e.target.value;
    globalSettings.theme = theme;
    applyTheme(theme);
    scheduleAutoSave();
});

function applyBuiltinTheme(theme) {
    const root = document.documentElement;
    if (theme === 'midnight') {
        root.style.setProperty('--bg-dark', '#050507');
        root.style.setProperty('--bg-sidebar', '#020203');
        root.style.setProperty('--panel-bg', '#0a0a12');
        root.style.setProperty('--accent-blue', '#6366f1');
        root.style.setProperty('--accent-purple', '#8b5cf6');
        root.style.setProperty('--text-main', '#f3f4f6');
    } else if (theme === 'slate') {
        root.style.setProperty('--bg-dark', '#1e293b');
        root.style.setProperty('--bg-sidebar', '#0f172a');
        root.style.setProperty('--panel-bg', '#334155');
        root.style.setProperty('--accent-blue', '#38bdf8');
        root.style.setProperty('--accent-purple', '#94a3b8');
        root.style.setProperty('--text-main', '#f8fafc');
    } else if (theme === 'cyberpunk') {
        root.style.setProperty('--bg-dark', '#050505');
        root.style.setProperty('--bg-sidebar', '#000000');
        root.style.setProperty('--panel-bg', '#0f0f12');
        root.style.setProperty('--accent-blue', '#ff00ff');
        root.style.setProperty('--accent-purple', '#00ffff');
        root.style.setProperty('--text-main', '#00ff00');
    } else if (theme === 'forest') {
        root.style.setProperty('--bg-dark', '#0b120f');
        root.style.setProperty('--bg-sidebar', '#060a08');
        root.style.setProperty('--panel-bg', '#15211b');
        root.style.setProperty('--accent-blue', '#10b981');
        root.style.setProperty('--accent-purple', '#059669');
        root.style.setProperty('--text-main', '#ecfdf5');
    } else if (theme === 'monocle') {
        root.style.setProperty('--bg-dark', '#111111');
        root.style.setProperty('--bg-sidebar', '#000000');
        root.style.setProperty('--panel-bg', '#222222');
        root.style.setProperty('--accent-blue', '#ffffff');
        root.style.setProperty('--accent-purple', '#888888');
        root.style.setProperty('--text-main', '#ffffff');
    } else if (theme === 'sunset') {
        root.style.setProperty('--bg-dark', '#1a0f0f');
        root.style.setProperty('--bg-sidebar', '#120a0a');
        root.style.setProperty('--panel-bg', '#2d1a1a');
        root.style.setProperty('--accent-blue', '#f59e0b');
        root.style.setProperty('--accent-purple', '#ef4444');
        root.style.setProperty('--text-main', '#fff7ed');
    } else if (theme === 'ocean') {
        root.style.setProperty('--bg-dark', '#0f172a');
        root.style.setProperty('--bg-sidebar', '#020617');
        root.style.setProperty('--panel-bg', '#1e293b');
        root.style.setProperty('--accent-blue', '#0ea5e9');
        root.style.setProperty('--accent-purple', '#6366f1');
        root.style.setProperty('--text-main', '#f0f9ff');
    } else {
        // Reset to Pro Dark
        root.style.setProperty('--bg-dark', '#121217');
        root.style.setProperty('--bg-sidebar', '#0e0e12');
        root.style.setProperty('--panel-bg', '#1e1e26');
        root.style.setProperty('--accent-blue', '#3b82f6');
        root.style.setProperty('--accent-purple', '#8b5cf6');
        root.style.setProperty('--text-main', '#f3f4f6');
    }
}

function applyTheme(theme) {
    // Disable any active extension theme CSS first
    loadedThemes.forEach(t => { if (t.styleEl) t.styleEl.disabled = true; });

    if (theme && theme.startsWith('ext-')) {
        // Extension theme: reset vars to Pro Dark base, then enable CSS sheet
        applyBuiltinTheme('pro-dark');
        const slug = theme.slice(4);
        const extTheme = loadedThemes.find(t => t.id === slug);
        if (extTheme && extTheme.styleEl) extTheme.styleEl.disabled = false;
    } else {
        applyBuiltinTheme(theme);
    }
}

// Global UI Events
addRouteBtn.addEventListener('click', () => {
    const newRoute = new AudioRoute(Date.now());
    routes.push(newRoute);
    updateEmptyState();
    // If already in list mode, move the toggle to card level immediately
    if (routingGrid.classList.contains('list-mode')) applyListModeToggles();
});

// =====================================================================
// EFFECTS MODAL
// =====================================================================
const effectsModal = document.getElementById('effects-modal');
const effectsSidebar = effectsModal ? effectsModal.querySelector('.effects-sidebar') : null;
const effectsSettingsPane = effectsModal ? effectsModal.querySelector('.effect-settings-pane') : null;
let currentModalRoute = null;

if (effectsSidebar && effectsSettingsPane) {
    effectsSidebar.addEventListener('click', (e) => {
        const opt = e.target.closest('.effect-option');
        if (!opt) return;
        effectsSidebar.querySelectorAll('.effect-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        const effectId = opt.dataset.effect;
        if (currentModalRoute) currentModalRoute.setEffect(effectId);
        if (effectId === 'equalizer') {
            buildEQInPane(effectsSettingsPane, currentModalRoute);
        } else {
            const effDef = loadedEffects.find(e => e.id === effectId);
            if (effDef) buildCustomEffectInPane(effectsSettingsPane, currentModalRoute, effDef);
        }
    });
}


function buildEQInPane(pane, route) {
    pane.innerHTML = '';

    const h3 = document.createElement('h3');
    h3.textContent = 'Égaliseur';
    pane.appendChild(h3);

    const freqTable = {
        3:  [200, 1000, 8000],
        5:  [60, 250, 1000, 4000, 14000],
        10: [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    };
    const freqLabels = {
        3:  ['200Hz','1kHz','8kHz'],
        5:  ['60Hz','250Hz','1kHz','4kHz','14kHz'],
        10: ['32Hz','64Hz','125Hz','250Hz','500Hz','1kHz','2kHz','4kHz','8kHz','16kHz']
    };
    const count = route.eqValues.length || globalSettings.eqBands;
    const freqs  = freqTable[count]  || freqTable[5];
    const labels = freqLabels[count] || freqLabels[5];

    if (route.eqValues.length !== count) route.eqValues = new Array(count).fill(0);

    const container = document.createElement('div');
    container.className = 'eq-bars-container';

    freqs.forEach((freq, i) => {
        const band = document.createElement('div');
        band.className = 'eq-band';

        const dbVal = document.createElement('span');
        dbVal.className = 'eq-db-val';
        const v = route.eqValues[i] || 0;
        dbVal.textContent = `${v >= 0 ? '+' : ''}${v.toFixed(0)}dB`;
        dbVal.style.color = v < 0 ? 'var(--accent-purple)' : 'var(--accent-blue)';

        const wrap = document.createElement('div');
        wrap.className = 'eq-slider-wrap';

        const zeroLine = document.createElement('div');
        zeroLine.className = 'eq-zero-line';

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'eq-slider';
        slider.min = -12; slider.max = 12; slider.step = 0.5;
        slider.value = route.eqValues[i] || 0;

        slider.addEventListener('input', (e) => {
            const db = parseFloat(e.target.value);
            route.eqValues[i] = db;
            dbVal.textContent = `${db >= 0 ? '+' : ''}${db.toFixed(0)}dB`;
            dbVal.style.color = db < 0 ? 'var(--accent-purple)' : 'var(--accent-blue)';
            if (route.eqFilters && route.eqFilters[i] && route.audioContext) {
                route.eqFilters[i].gain.setTargetAtTime(db, route.audioContext.currentTime, 0.02);
            }
        });

        wrap.appendChild(zeroLine);
        wrap.appendChild(slider);

        const freqLabel = document.createElement('span');
        freqLabel.className = 'eq-freq-label';
        freqLabel.textContent = labels[i];

        band.appendChild(dbVal);
        band.appendChild(wrap);
        band.appendChild(freqLabel);
        container.appendChild(band);
    });

    pane.appendChild(container);

    const footer = document.createElement('div');
    footer.className = 'eq-bands-footer';

    const bandLabel = document.createElement('label');
    bandLabel.textContent = 'Bandes :';

    const bandSelect = document.createElement('select');
    [3, 5, 10].forEach(n => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.textContent = `${n} bandes`;
        if (n === (route.eqValues.length || globalSettings.eqBands)) opt.selected = true;
        bandSelect.appendChild(opt);
    });
    bandSelect.addEventListener('change', (e) => {
        const newCount = parseInt(e.target.value);
        globalSettings.eqBands = newCount;
        route.updateEQBands(newCount);
        buildEQInPane(pane, route);
    });

    const resetBtn = document.createElement('button');
    resetBtn.className = 'eq-reset-btn';
    resetBtn.textContent = 'Réinitialiser';
    resetBtn.addEventListener('click', () => {
        route.eqValues.fill(0);
        container.querySelectorAll('.eq-slider').forEach(s => { s.value = 0; });
        container.querySelectorAll('.eq-db-val').forEach(s => {
            s.textContent = '+0dB';
            s.style.color = 'var(--accent-blue)';
        });
        if (route.eqFilters && route.audioContext) {
            route.eqFilters.forEach(f => f && f.gain.setTargetAtTime(0, route.audioContext.currentTime, 0.02));
        }
    });

    footer.appendChild(bandLabel);
    footer.appendChild(bandSelect);
    footer.appendChild(resetBtn);
    pane.appendChild(footer);
}


function buildCustomEffectInPane(pane, route, effectDef) {
    pane.innerHTML = '';
    if (!route.effectEnabledState) route.effectEnabledState = {};
    if (route.effectEnabledState[effectDef.id] === undefined) route.effectEnabledState[effectDef.id] = true;

    const h3 = document.createElement('h3');
    h3.textContent = effectDef.nom;
    pane.appendChild(h3);

    if (!route.effectParams) route.effectParams = {};
    if (!route.effectParams[effectDef.id]) route.effectParams[effectDef.id] = {};

    effectDef.params.forEach(param => {
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display:flex;align-items:center;gap:12px;margin-bottom:16px;';

        const label = document.createElement('label');
        label.textContent = param.name;
        label.style.cssText = 'width:160px;font-size:0.85rem;color:var(--text-dim);flex-shrink:0;';

        const paramKey = param.id || param.name;
        const currentVal = (route.effectParams[effectDef.id][paramKey] !== undefined)
            ? route.effectParams[effectDef.id][paramKey]
            : param.default;

        wrapper.appendChild(label);

        if (param.type === 'select' || param.options) {
            const btnGroup = document.createElement('div');
            btnGroup.style.cssText = 'display:flex;gap:6px;flex:1;flex-wrap:wrap;';

            const options = param.options || [];
            options.forEach(opt => {
                const optVal = opt.hasOwnProperty('value') ? opt.value : opt;
                const optLabel = opt.hasOwnProperty('label') ? opt.label : opt;

                const btn = document.createElement('button');
                btn.textContent = optLabel;
                btn.style.cssText = 'padding:6px 12px;font-size:0.8rem;border-radius:6px;border:1px solid var(--panel-border);background:var(--card-bg);color:var(--text-dim);cursor:pointer;transition:all 0.2s;';
                if (currentVal == optVal) {
                    btn.style.background = 'var(--accent-blue)';
                    btn.style.color = '#fff';
                    btn.style.borderColor = 'var(--accent-blue)';
                }
                btn.addEventListener('click', () => {
                    btnGroup.querySelectorAll('button').forEach(b => {
                        b.style.background = 'var(--card-bg)';
                        b.style.color = 'var(--text-dim)';
                        b.style.borderColor = 'var(--panel-border)';
                    });
                    btn.style.background = 'var(--accent-blue)';
                    btn.style.color = '#fff';
                    btn.style.borderColor = 'var(--accent-blue)';
                    route.effectParams[effectDef.id][paramKey] = optVal;
                    const node = route.customEffectNodes && route.customEffectNodes[effectDef.id];
                    if (node && typeof node.setParam === 'function') {
                        try { node.setParam(paramKey, optVal); } catch(err) {}
                    }
                    scheduleAutoSave();
                });
                btnGroup.appendChild(btn);
            });
            wrapper.appendChild(btnGroup);
        } else {
            const slider = document.createElement('input');
            slider.type = 'range';
            slider.min = param.min; slider.max = param.max; slider.step = param.step || 0.01;
            slider.value = currentVal;
            slider.style.flex = '1';

            const valDisplay = document.createElement('span');
            valDisplay.textContent = Number(currentVal).toFixed(2);
            valDisplay.style.cssText = 'width:48px;text-align:right;font-size:0.85rem;color:var(--accent-blue);font-variant-numeric:tabular-nums;';

            slider.addEventListener('input', (e) => {
                const val = parseFloat(e.target.value);
                valDisplay.textContent = val.toFixed(2);
                route.effectParams[effectDef.id][paramKey] = val;
                const node = route.customEffectNodes && route.customEffectNodes[effectDef.id];
                if (node && typeof node.setParam === 'function') {
                    try { node.setParam(paramKey, val); } catch(err) {}
                }
                scheduleAutoSave();
            });

            wrapper.appendChild(slider);
            wrapper.appendChild(valDisplay);
        }

        pane.appendChild(wrapper);
    });
}

function openEffectsModal(route) {
    currentModalRoute = route;
    effectsModal.classList.add('open');
    if (!route.effectEnabledState) route.effectEnabledState = { equalizer: true };

    function buildSidebarItem(id, label) {
        const isActive = (!route.activeEffectType && id === 'equalizer') || route.activeEffectType === id;
        const isEnabled = route.effectEnabledState[id] !== false;

        const item = document.createElement('div');
        item.className = 'effect-option' + (isActive ? ' active' : '');
        item.dataset.effect = id;
        item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = label;
        nameSpan.style.flex = '1';
        nameSpan.style.pointerEvents = 'none';

        // Mini inline toggle
        const toggleLabel = document.createElement('label');
        toggleLabel.className = 'switch';
        toggleLabel.style.cssText = 'transform:scale(0.7);flex-shrink:0;margin:0;';
        toggleLabel.onclick = (e) => e.stopPropagation(); // Don't select effect on toggle click
        toggleLabel.innerHTML = `
            <input type="checkbox" ${isEnabled ? 'checked' : ''} style="">
            <span class="slider round"></span>
        `;
        const chk = toggleLabel.querySelector('input');
        chk.addEventListener('change', (e) => {
            const checked = e.target.checked;
            route.effectEnabledState[id] = checked;
            if (checked && id !== 'equalizer' && route.audioContext) {
                // Lazy-create the effect node when first enabled
                if (!route.customEffectNodes[id]) {
                    route.setupCustomEffect(id);
                }
            }
            route.connectEffectsChain();
            scheduleAutoSave();
            nameSpan.style.opacity = checked ? '1' : '0.4';
        });
        if (!isEnabled) nameSpan.style.opacity = '0.4';

        item.appendChild(nameSpan);
        item.appendChild(toggleLabel);
        return item;
    }

    // Rebuild entire sidebar with inline toggles
    effectsSidebar.innerHTML = '';
    effectsSidebar.appendChild(buildSidebarItem('equalizer', 'Égaliseur'));
    loadedEffects.forEach(eff => {
        effectsSidebar.appendChild(buildSidebarItem(eff.id, eff.nom));
    });

    // Initial pane render
    const isEQ = !route.activeEffectType || route.activeEffectType === 'equalizer';
    if (isEQ) {
        buildEQInPane(effectsSettingsPane, route);
    } else {
        const effDef = loadedEffects.find(e => e.id === route.activeEffectType);
        if (effDef) buildCustomEffectInPane(effectsSettingsPane, route, effDef);
        else buildEQInPane(effectsSettingsPane, route);
    }
}

// Close modal
effectsModal.querySelector('.modal-close').addEventListener('click', () => {
    effectsModal.classList.remove('open');
    currentModalRoute = null;
});
effectsModal.addEventListener('click', (e) => {
    if (e.target === effectsModal) {
        effectsModal.classList.remove('open');
        currentModalRoute = null;
    }
});

// =====================================================================
// CONFIG IMPORT / EXPORT
// =====================================================================
function buildConfig() {
    return {
        version: 1,
        masterVolume,
        isMasterMuted,
        globalSettings: { ...globalSettings },
        routes: routes.map(r => ({
            name:            r.name,
            inputId:         r.inputId,
            outputId:        r.outputId,
            outputIds:       [r.outputId, ...r.extraOutputContexts.map(e => e.outputId)].filter(Boolean),
            isActive:        r.isActive,
            gainValue:       r.gainValue,
            delayValue:      r.delayValue,
            eqValues:        [...r.eqValues],
            activeEffectType: r.activeEffectType,
            effectParams:    r.effectParams || {},
            effectEnabledState: r.effectEnabledState || {},
            channelStates:   r.channelStates || {}
        }))
    };
}

async function exportConfig() {
    const data = JSON.stringify(buildConfig(), null, 2);
    const result = await window.electron.saveConfigFile(data);
    if (result && result.success) {
        showToast(`✅ Configuration exportée vers ${result.filePath.split('\\').pop()}`);
    }
}

async function importConfig() {
    const result = await window.electron.loadConfigFile();
    if (!result || !result.success) return;
    try {
        const cfg = JSON.parse(result.content);
        if (cfg.masterVolume !== undefined) masterVolume = cfg.masterVolume;
        if (cfg.isMasterMuted !== undefined) isMasterMuted = cfg.isMasterMuted;
        applyMasterVolumeUI();
        // Apply global settings
        if (cfg.globalSettings) {
            Object.assign(globalSettings, cfg.globalSettings);
            applyTheme(globalSettings.theme);
            document.getElementById('setting-theme').value          = globalSettings.theme;
            document.getElementById('setting-sample-rate').value    = globalSettings.sampleRate;
            document.getElementById('setting-latency').value        = globalSettings.latencyHint;
            document.getElementById('setting-gain-max').value       = globalSettings.gainMax;
            const eqBandsEl = document.getElementById('setting-eq-bands');
            if (eqBandsEl) eqBandsEl.value = globalSettings.eqBands;
            document.getElementById('setting-vu-speed').value       = globalSettings.vuDecay;
            document.getElementById('setting-delay-min').value      = globalSettings.delayMin * 1000;
            document.getElementById('setting-delay-max').value      = globalSettings.delayMax * 1000;

            // Restore Display Mode & Grid Columns
            if (globalSettings.displayMode) applyDisplayMode(globalSettings.displayMode);
            if (globalSettings.gridCols) applyGridCols(globalSettings.gridCols);
        }
        // Destroy existing routes
        [...routes].forEach(r => r.destroy());
        // Recreate from config
        if (cfg.routes && Array.isArray(cfg.routes)) {
            for (const rc of cfg.routes) {
                const newRoute = new AudioRoute(Date.now() + Math.random());
                newRoute.name = rc.name;
                newRoute.titleInput.value = rc.name;
                newRoute.gainValue = rc.gainValue;
                newRoute.gainSlider.value = rc.gainValue;
                newRoute.updateGain(rc.gainValue);
                newRoute.delayValue = rc.delayValue;
                newRoute.delaySlider.value = rc.delayValue;
                newRoute.updateDelay(rc.delayValue);
                newRoute.eqValues = rc.eqValues || [];
                newRoute.activeEffectType = rc.activeEffectType || 'equalizer';
                newRoute.effectParams = rc.effectParams || {};
                newRoute.effectEnabledState = rc.effectEnabledState || { equalizer: true };
                newRoute.channelStates = rc.channelStates || {};
                newRoute.isActive = rc.isActive;
                newRoute.toggle.checked = rc.isActive;
                routes.push(newRoute);
                // Restore channel button appearance
                newRoute._restoreChannelButtonAppearance();
                // Select devices — fallback to first available if saved ID is gone
                if (rc.inputId) {
                    newRoute.inputSelect.value = rc.inputId;
                    if (!newRoute.inputSelect.value && devices.inputs.length > 0)
                        newRoute.inputSelect.value = devices.inputs[0].deviceId;
                }
                if (rc.outputId) {
                    newRoute.outputSelect.value = rc.outputId;
                    if (!newRoute.outputSelect.value && devices.outputs.length > 0)
                        newRoute.outputSelect.value = devices.outputs[0].deviceId;
                }
                if (newRoute.inputSelect.value && newRoute.outputSelect.value) await newRoute.setupAudio();
            }
        }
        updateEmptyState();
        showToast('✅ Configuration chargée avec succès !');
    } catch(err) {
        console.error('Import config error:', err);
        showToast('❌ Erreur lors du chargement de la configuration.');
    }
}

// Listen for menu triggers
if (window.electron.onExportConfig) window.electron.onExportConfig(() => exportConfig());
if (window.electron.onLoadConfig)   window.electron.onLoadConfig(()   => importConfig());

// =====================================================================
// TOAST NOTIFICATION
// =====================================================================
function showToast(msg, duration = 3500) {
    let toast = document.getElementById('as-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'as-toast';
        toast.style.cssText = [
            'position:fixed', 'bottom:24px', 'right:24px', 'z-index:9999',
            'background:var(--panel-bg)', 'border:1px solid var(--panel-border)',
            'color:var(--text-main)', 'padding:12px 20px', 'border-radius:12px',
            'font-size:0.9rem', 'box-shadow:0 8px 30px rgba(0,0,0,0.4)',
            'transition:opacity 0.4s ease', 'opacity:0', 'pointer-events:none'
        ].join(';');
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}

// =====================================================================
// EXTENSION (.aspack) LOADING
// =====================================================================
function registerThemeExtension(ext) {
    const existing = loadedThemes.find(t => t.id === ext.slug);
    if (existing) {
        if (existing.styleEl) existing.styleEl.textContent = ext.cssContent;
        return 'updated';
    }
    const styleEl = document.createElement('style');
    styleEl.id = `theme-ext-${ext.slug}`;
    styleEl.textContent = ext.cssContent;
    document.head.appendChild(styleEl);
    styleEl.disabled = true; // not applied until user selects it

    loadedThemes.push({ id: ext.slug, nom: ext.nom, cssContent: ext.cssContent, styleEl });

    // Add to theme dropdown
    const themeSelect = document.getElementById('setting-theme');
    if (!themeSelect.querySelector(`option[value="ext-${ext.slug}"]`)) {
        const opt = document.createElement('option');
        opt.value = `ext-${ext.slug}`;
        opt.textContent = ext.nom;
        themeSelect.appendChild(opt);
    }
    return 'installed';
}

function registerEffectExtension(ext) {
    const existing = loadedEffects.find(e => e.id === ext.slug);

    let effectDef;
    try {
        effectDef = eval(ext.jsContent);
    } catch(err) {
        console.error(`Failed to evaluate effect plugin "${ext.nom}":`, err);
        showToast(`Erreur lors du chargement de l'effet "${ext.nom}".`);
        return false;
    }

    if (!effectDef || typeof effectDef.createNodes !== 'function') {
        showToast(`Plugin "${ext.nom}" invalide (createNodes manquant).`);
        return false;
    }

    const entry = {
        id:          ext.slug,
        nom:         ext.nom,
        params:      effectDef.params || [],
        createNodes: effectDef.createNodes
    };

    if (existing) {
        // Update in place
        Object.assign(existing, entry);
        if (effectsModal && effectsModal.classList.contains('open') && currentModalRoute) {
            openEffectsModal(currentModalRoute);
        }
        return 'updated';
    }

    loadedEffects.push(entry);
    if (effectsModal && effectsModal.classList.contains('open') && currentModalRoute) {
        openEffectsModal(currentModalRoute);
    }
    return 'installed';
}

function applyExtensionTheme(themeId) {
    // Disable all extension themes
    loadedThemes.forEach(t => { if (t.styleEl) t.styleEl.disabled = true; });

    if (themeId && themeId.startsWith('ext-')) {
        const slug = themeId.slice(4);
        const theme = loadedThemes.find(t => t.id === slug);
        if (theme && theme.styleEl) theme.styleEl.disabled = false;
    }
}

// applyTheme is already defined above and handles extension themes natively

async function installExtensionFromPath(filePath) {
    showToast('Installation de l\'extension...');
    const result = await window.electron.installExtension(filePath);
    if (!result || !result.success) {
        showToast(`Erreur : ${result ? result.error : 'Erreur inconnue'}`);
        return;
    }
    const ext = result.extension;
    if (ext.type === 'theme') {
        const status = registerThemeExtension(ext);
        showToast(`Theme "${ext.nom}" ${status === 'updated' ? 'mis a jour' : 'installe'} (v${ext.version})`);
    } else if (ext.type === 'audio_effect') {
        const status = registerEffectExtension(ext);
        if (status) showToast(`Effet "${ext.nom}" ${status === 'updated' ? 'mis a jour' : 'installe'} (v${ext.version})`);
    } else {
        showToast(`Type d'extension inconnu : ${ext.type}`);
    }
    // Refresh the installed extensions panel
    if (typeof renderInstalledExtensions === 'function') renderInstalledExtensions();
}

async function loadPersistedExtensions() {
    try {
        const list = await window.electron.loadExtensions();
        list.forEach(ext => {
            if (ext.type === 'theme' && ext.cssContent) registerThemeExtension(ext);
            else if (ext.type === 'audio_effect' && ext.jsContent) registerEffectExtension(ext);
        });
        if (list.length > 0) console.log(`${list.length} extension(s) chargée(s).`);
    } catch(err) {
        console.error('Failed to load persisted extensions:', err);
    }
}

// Drop Zone
const dropZone  = document.getElementById('drop-zone');
const fileInput = document.getElementById('extension-file-input');

// Electron 32+ removed File.path — use webUtils.getPathForFile() instead
function getFilePath(file) {
    try {
        const { webUtils } = require('electron');
        return webUtils.getPathForFile(file);
    } catch(e) {
        // Fallback for older Electron
        return file.path;
    }
}

if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) installExtensionFromPath(getFilePath(file));
        fileInput.value = '';
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith('.aspack')) {
            installExtensionFromPath(getFilePath(file));
        } else if (file) {
            showToast('Veuillez deposer un fichier .aspack valide.');
        }
    });
}


// AUTO-SAVE / AUTO-LOAD CONFIG (localStorage)
// =====================================================================
const AUTO_SAVE_KEY = 'as-auto-config-v1';
let _autoSaveTimer = null;

function autoSaveConfig() {
    try {
        localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(buildConfig()));
    } catch(e) {
        console.warn('Auto-save failed:', e);
    }
}

// Debounced: groups rapid changes into one save 2s later
function scheduleAutoSave() {
    clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(autoSaveConfig, 2000);
}

async function autoLoadConfig() {
    try {
        const saved = localStorage.getItem(AUTO_SAVE_KEY);
        if (!saved) return;
        const cfg = JSON.parse(saved);
        if (!cfg || !cfg.routes) return;

        if (cfg.masterVolume !== undefined) masterVolume = cfg.masterVolume;
        if (cfg.isMasterMuted !== undefined) isMasterMuted = cfg.isMasterMuted;
        applyMasterVolumeUI();

        // Apply global settings
        if (cfg.globalSettings) {
            Object.assign(globalSettings, cfg.globalSettings);
            applyTheme(globalSettings.theme);
            const el = (id) => document.getElementById(id);
            el('setting-theme').value       = globalSettings.theme;
            el('setting-sample-rate').value = globalSettings.sampleRate;
            el('setting-latency').value     = globalSettings.latencyHint;
            el('setting-gain-max').value    = globalSettings.gainMax;
            el('setting-eq-bands') && (el('setting-eq-bands').value = globalSettings.eqBands);
            el('setting-vu-speed').value    = globalSettings.vuDecay;
            el('setting-delay-min').value   = globalSettings.delayMin * 1000;
            el('setting-delay-max').value   = globalSettings.delayMax * 1000;

            // Restore Display Mode & Grid Columns
            if (globalSettings.displayMode) applyDisplayMode(globalSettings.displayMode);
            if (globalSettings.gridCols) applyGridCols(globalSettings.gridCols);
        }

        // Destroy existing default routes
        [...routes].forEach(r => r.destroy());

        // Recreate routes from saved config
        for (const rc of cfg.routes) {
            const newRoute = new AudioRoute(Date.now() + Math.random());
            newRoute.name = rc.name;
            newRoute.titleInput.value = rc.name;
            newRoute.gainValue = rc.gainValue;
            newRoute.gainSlider.value = rc.gainValue;
            newRoute.updateGain(rc.gainValue);
            newRoute.delayValue = rc.delayValue;
            newRoute.delaySlider.value = rc.delayValue;
            newRoute.updateDelay(rc.delayValue);
            newRoute.eqValues = rc.eqValues || [];
            newRoute.activeEffectType = rc.activeEffectType || 'equalizer';
            newRoute.effectParams = rc.effectParams || {};
            newRoute.effectEnabledState = rc.effectEnabledState || { equalizer: true };
            newRoute.channelStates = rc.channelStates || {};
            newRoute.isActive = rc.isActive;
            newRoute.toggle.checked = rc.isActive;
            routes.push(newRoute);
            if (rc.inputId) {
                newRoute.inputSelect.value = rc.inputId;
                if (!newRoute.inputSelect.value && devices.inputs.length > 0)
                    newRoute.inputSelect.value = devices.inputs[0].deviceId;
            }
            // Support both legacy `outputId` and new `outputIds` array
            const outputIds = rc.outputIds || (rc.outputId ? [rc.outputId] : []);
            const primaryOutputId = outputIds[0] || '';
            if (primaryOutputId) {
                newRoute.outputSelect.value = primaryOutputId;
                if (!newRoute.outputSelect.value && devices.outputs.length > 0)
                    newRoute.outputSelect.value = devices.outputs[0].deviceId;
            }
            if (newRoute.inputSelect.value && newRoute.outputSelect.value) await newRoute.setupAudio();
            // Restore extra outputs (after setupAudio so audioContext exists)
            for (let i = 1; i < outputIds.length; i++) {
                if (outputIds[i]) newRoute.addOutputRow(outputIds[i]);
            }
            // Restore channel button appearance
            newRoute._restoreChannelButtonAppearance();
        }

        updateEmptyState();
        // Re-apply list mode toggle positions if we're in list mode
        if (routingGrid.classList.contains('list-mode')) applyListModeToggles();
        console.log('Config restauree automatiquement.');
    } catch(e) {
        console.warn('Auto-load config failed:', e);
    }
}

// Save on close (synchronous localStorage works in beforeunload)
window.addEventListener('beforeunload', () => {
    clearTimeout(_autoSaveTimer);
    autoSaveConfig();
});

function updateAllRouteGains() {
    const effectiveVolume = isMasterMuted ? 0 : masterVolume;
    routes.forEach(route => {
        if (route.gainNode && route.audioContext) {
            const targetGain = route.gainValue * effectiveVolume;
            route.gainNode.gain.setTargetAtTime(targetGain, route.audioContext.currentTime, 0.02);
        }
    });
}

function applyMasterVolumeUI() {
    const slider = document.getElementById('master-volume-slider');
    const valSpan = document.getElementById('master-volume-val');
    const muteBtn = document.getElementById('btn-master-mute');
    if (slider) slider.value = masterVolume;
    if (valSpan) valSpan.textContent = `${Math.round(masterVolume * 100)}%`;
    if (muteBtn) {
        if (isMasterMuted) {
            muteBtn.classList.add('muted');
            muteBtn.querySelector('.mute-icon-muted').style.display = 'block';
            muteBtn.querySelector('.mute-icon-unmuted').style.display = 'none';
        } else {
            muteBtn.classList.remove('muted');
            muteBtn.querySelector('.mute-icon-muted').style.display = 'none';
            muteBtn.querySelector('.mute-icon-unmuted').style.display = 'block';
        }
    }
    updateAllRouteGains();
}

// =====================================================================
// AUDIO CPU MONITORING
// =====================================================================
/**
 * Calculate estimated audio CPU load based on active nodes and effects
 * @returns {number} Estimated CPU percentage (0-100)
 */
function calculateAudioCPU() {
    let cpuLoad = 0;
    
    routes.forEach(route => {
        // Skip inactive routes
        if (!route.isActive || !route.audioContext) return;
        
        // Base CPU cost for running an active audio route: 5%
        cpuLoad += 5;
        
        // Cost for EQ filters (only if enabled): 0.8% per band
        const eqEnabled = route.effectEnabledState && route.effectEnabledState['equalizer'] !== false;
        if (eqEnabled && route.eqFilters) {
            cpuLoad += route.eqFilters.length * 0.8;
        }
        
        // Cost for each active custom effect: 3% per effect
        Object.keys(route.customEffectNodes).forEach(effectId => {
            const effectEnabled = route.effectEnabledState && route.effectEnabledState[effectId] !== false;
            if (effectEnabled) {
                cpuLoad += 3;
            }
        });
        
        // Cost for delay node (only if non-zero delay): 1.5%
        if (route.delayNode && route.delayValue !== 0) {
            cpuLoad += 1.5;
        }
    });
    
    // Cap to 100%
    return Math.min(100, cpuLoad);
}

// =====================================================================
// Initial load
// =====================================================================
window.addEventListener('load', async () => {
    await refreshDevices();
    await loadPersistedExtensions();

    // Restore saved config AFTER extensions are loaded
    // (so custom effect types referenced in routes are already registered)
    await autoLoadConfig();

    // Wire Master Volume controls
    const masterSlider = document.getElementById('master-volume-slider');
    const masterValSpan = document.getElementById('master-volume-val');
    const masterMuteBtn = document.getElementById('btn-master-mute');

    if (masterSlider) {
        masterSlider.addEventListener('input', (e) => {
            masterVolume = parseFloat(e.target.value);
            if (masterValSpan) masterValSpan.textContent = `${Math.round(masterVolume * 100)}%`;
            updateAllRouteGains();
            scheduleAutoSave();
        });
    }

    if (masterMuteBtn) {
        masterMuteBtn.addEventListener('click', () => {
            isMasterMuted = !isMasterMuted;
            if (isMasterMuted) {
                masterMuteBtn.classList.add('muted');
                masterMuteBtn.querySelector('.mute-icon-muted').style.display = 'block';
                masterMuteBtn.querySelector('.mute-icon-unmuted').style.display = 'none';
            } else {
                masterMuteBtn.classList.remove('muted');
                masterMuteBtn.querySelector('.mute-icon-muted').style.display = 'none';
                masterMuteBtn.querySelector('.mute-icon-unmuted').style.display = 'block';
            }
            updateAllRouteGains();
            scheduleAutoSave();
        });
    }

    // Auto-refresh when devices change
    navigator.mediaDevices.ondevicechange = refreshDevices;

    // Monitor Audio Latency (Sum of base input-to-output latency and hardware output device latency)
    setInterval(() => {
        if (routes.length > 0 && routes[0].audioContext) {
            const ctx = routes[0].audioContext;
            const totalLat = ((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * 1000;
            const el = document.getElementById('latency-val');
            if (el) el.innerText = `${totalLat.toFixed(1)} ms`;
        }
    }, 1000);

    // Monitor Audio CPU Load (get real CPU usage from the system)
    setInterval(async () => {
        try {
            const cpuLoad = window.electron && window.electron.getCPUUsage ? await window.electron.getCPUUsage() : calculateAudioCPU();
            const el = document.getElementById('cpu-val');
            if (el) el.innerText = `${Math.round(cpuLoad)}%`;
        } catch (e) {
            console.error('Error fetching CPU usage:', e);
        }
    }, 1000);

    // Global gesture handler to resume suspended AudioContexts
    const resumeAllContexts = async () => {
        for (const route of routes) {
            if (route.audioContext && route.audioContext.state === 'suspended') {
                try {
                    await route.audioContext.resume();
                } catch (e) {}
            }
        }
    };
    window.addEventListener('click', resumeAllContexts);
    window.addEventListener('keydown', resumeAllContexts);

    // Check for update in background (non-blocking)
    checkForAppUpdate();

    // Populate installed extensions list in Settings
    renderInstalledExtensions();
});

// =====================================================================
// AUTO-UPDATE CHECKER
// =====================================================================
let _latestReleaseDownloadUrl = null;

function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

async function checkForAppUpdate() {
    try {
        const [currentVersion, result] = await Promise.all([
            window.electron.getAppVersion(),
            window.electron.checkForUpdate()
        ]);

        const versionEl = document.getElementById('info-app-version');
        if (versionEl && currentVersion) {
            versionEl.textContent = currentVersion;
        }

        if (!result.success || !result.latestVersion) return;

        const isNewer = compareVersions(result.latestVersion, currentVersion) > 0;
        if (!isNewer) return;

        // Show the animated update banner in sidebar
        _latestReleaseDownloadUrl = result.downloadUrl;
        const banner = document.getElementById('update-banner');
        const label = document.getElementById('update-label');
        if (banner) {
            label.textContent = `v${result.latestVersion} disponible !`;
            banner.style.display = 'block';
        }
    } catch(e) {
        // Silent fail — no internet or no releases yet
    }
}

// Wire update button
const _updateBtn = document.getElementById('btn-update');
if (_updateBtn) {
    _updateBtn.addEventListener('click', async () => {
        if (!_latestReleaseDownloadUrl) {
            showToast('⚠️ Pas de fichier .exe trouvé dans la release. Ouvrez GitHub manuellement.');
            return;
        }
        _updateBtn.disabled = true;
        _updateBtn.querySelector('span').textContent = '⏳ Téléchargement...';
        try {
            const result = await window.electron.downloadAndInstallUpdate(_latestReleaseDownloadUrl);
            if (result.success) {
                showToast('✅ Mise à jour téléchargée ! Suivez les instructions de l\'installateur.');
            } else {
                showToast(`❌ Erreur mise à jour : ${result.error}`);
                _updateBtn.disabled = false;
                _updateBtn.querySelector('span').textContent = 'Réessayer';
            }
        } catch(e) {
            showToast(`❌ Erreur : ${e.message}`);
            _updateBtn.disabled = false;
        }
    });
}

// =====================================================================
// INSTALLED EXTENSIONS MANAGER
// =====================================================================
function renderInstalledExtensions() {
    const container = document.getElementById('installed-extensions-list');
    if (!container) return;

    // Combine both loaded arrays
    const allExt = [
        ...loadedThemes.map(t => ({ id: t.id, nom: t.nom, type: 'Thème', slug: t.id })),
        ...loadedEffects.map(e => ({ id: e.id, nom: e.nom, type: 'Effet Audio', slug: e.id }))
    ];

    if (allExt.length === 0) {
        container.innerHTML = '<p style="opacity: 0.5; font-size: 0.85rem; text-align:center; padding: 12px 0;">Aucune extension installée.</p>';
        return;
    }

    container.innerHTML = '';
    allExt.forEach(ext => {
        const item = document.createElement('div');
        item.className = 'ext-item';
        item.innerHTML = `
            <div class="ext-item-info">
                <span class="ext-item-name">${ext.nom}</span>
                <span class="ext-item-meta">${ext.type}</span>
            </div>
            <button class="btn-del-ext" data-slug="${ext.slug}">🗑 Supprimer</button>
        `;
        item.querySelector('.btn-del-ext').addEventListener('click', async () => {
            if (!confirm(`Voulez-vous vraiment supprimer définitivement l'extension "${ext.nom}" ?`)) return;
            try {
                const result = await window.electron.deleteExtension(ext.slug);
                if (result.success) {
                    showToast(`✅ Extension "${ext.nom}" supprimée.`);
                    
                    // Remove from loaded arrays
                    loadedThemes = loadedThemes.filter(t => t.id !== ext.slug);
                    loadedEffects = loadedEffects.filter(e => e.id !== ext.slug);

                    // Remove from dropdown in settings if it's a theme
                    const themeSelect = document.getElementById('setting-theme');
                    if (themeSelect) {
                        const opt = themeSelect.querySelector(`option[value="ext-${ext.slug}"]`);
                        if (opt) opt.remove();

                        // If deleted theme was active, revert to default 'pro-dark'
                        if (globalSettings.theme === `ext-${ext.slug}`) {
                            globalSettings.theme = 'pro-dark';
                            themeSelect.value = 'pro-dark';
                            applyTheme('pro-dark');
                        }
                    }

                    // Remove the DOM element from the list
                    item.remove();
                    
                    // If no extensions remain, show empty state
                    const remainingExt = [
                        ...loadedThemes,
                        ...loadedEffects
                    ];
                    if (remainingExt.length === 0) {
                        container.innerHTML = '<p style="opacity: 0.5; font-size: 0.85rem; text-align:center; padding: 12px 0;">Aucune extension installée.</p>';
                    }
                } else {
                    showToast(`❌ Erreur : ${result.error}`);
                }
            } catch(e) {
                showToast(`❌ Erreur : ${e.message}`);
            }
        });
        container.appendChild(item);
    });
}
