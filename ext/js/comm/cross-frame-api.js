/*
 * Copyright (C) 2023  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {EventDispatcher, EventListenerCollection, invokeMessageHandler, log} from '../core.js';
import {ExtensionError} from '../core/extension-error.js';
import {parseJson} from '../core/json.js';
import {yomitan} from '../yomitan.js';

/**
 * @augments EventDispatcher<import('cross-frame-api').CrossFrameAPIPortEventType>
 */
class CrossFrameAPIPort extends EventDispatcher {
    /**
     * @param {number} otherTabId
     * @param {number} otherFrameId
     * @param {chrome.runtime.Port} port
     * @param {import('core').MessageHandlerMap} messageHandlers
     */
    constructor(otherTabId, otherFrameId, port, messageHandlers) {
        super();
        /** @type {number} */
        this._otherTabId = otherTabId;
        /** @type {number} */
        this._otherFrameId = otherFrameId;
        /** @type {?chrome.runtime.Port} */
        this._port = port;
        /** @type {import('core').MessageHandlerMap} */
        this._messageHandlers = messageHandlers;
        /** @type {Map<number, import('cross-frame-api').Invocation>} */
        this._activeInvocations = new Map();
        /** @type {number} */
        this._invocationId = 0;
        /** @type {EventListenerCollection} */
        this._eventListeners = new EventListenerCollection();
    }

    /** @type {number} */
    get otherTabId() {
        return this._otherTabId;
    }

    /** @type {number} */
    get otherFrameId() {
        return this._otherFrameId;
    }

    /**
     * @throws {Error}
     */
    prepare() {
        if (this._port === null) { throw new Error('Invalid state'); }
        this._eventListeners.addListener(this._port.onDisconnect, this._onDisconnect.bind(this));
        this._eventListeners.addListener(this._port.onMessage, this._onMessage.bind(this));
    }

    /**
     * @template [TParams=import('core').SerializableObject]
     * @template [TReturn=unknown]
     * @param {string} action
     * @param {TParams} params
     * @param {number} ackTimeout
     * @param {number} responseTimeout
     * @returns {Promise<TReturn>}
     */
    invoke(action, params, ackTimeout, responseTimeout) {
        return new Promise((resolve, reject) => {
            if (this._port === null) {
                reject(new Error(`Port is disconnected (${action})`));
                return;
            }

            const id = this._invocationId++;
            /** @type {import('cross-frame-api').Invocation} */
            const invocation = {
                id,
                resolve,
                reject,
                responseTimeout,
                action,
                ack: false,
                timer: null
            };
            this._activeInvocations.set(id, invocation);

            if (ackTimeout !== null) {
                try {
                    invocation.timer = setTimeout(() => this._onError(id, 'Acknowledgement timeout'), ackTimeout);
                } catch (e) {
                    this._onError(id, 'Failed to set timeout');
                    return;
                }
            }

            try {
                this._port.postMessage(/** @type {import('cross-frame-api').InvokeMessage} */ ({type: 'invoke', id, data: {action, params}}));
            } catch (e) {
                this._onError(id, e);
            }
        });
    }

    /** */
    disconnect() {
        this._onDisconnect();
    }

    // Private

    /** */
    _onDisconnect() {
        if (this._port === null) { return; }
        this._eventListeners.removeAllEventListeners();
        this._port = null;
        for (const id of this._activeInvocations.keys()) {
            this._onError(id, 'Disconnected');
        }
        this.trigger('disconnect', this);
    }

    /**
     * @param {import('cross-frame-api').Message} details
     */
    _onMessage(details) {
        const {type, id} = details;
        switch (type) {
            case 'invoke':
                this._onInvoke(id, details.data);
                break;
            case 'ack':
                this._onAck(id);
                break;
            case 'result':
                this._onResult(id, details.data);
                break;
        }
    }

    // Response handlers

    /**
     * @param {number} id
     */
    _onAck(id) {
        const invocation = this._activeInvocations.get(id);
        if (typeof invocation === 'undefined') {
            log.warn(new Error(`Request ${id} not found for acknowledgement`));
            return;
        }

        if (invocation.ack) {
            this._onError(id, `Request ${id} already acknowledged`);
            return;
        }

        invocation.ack = true;

        if (invocation.timer !== null) {
            clearTimeout(invocation.timer);
            invocation.timer = null;
        }

        const responseTimeout = invocation.responseTimeout;
        if (responseTimeout !== null) {
            try {
                invocation.timer = setTimeout(() => this._onError(id, 'Response timeout'), responseTimeout);
            } catch (e) {
                this._onError(id, 'Failed to set timeout');
            }
        }
    }

    /**
     * @param {number} id
     * @param {import('core').Response<unknown>} data
     */
    _onResult(id, data) {
        const invocation = this._activeInvocations.get(id);
        if (typeof invocation === 'undefined') {
            log.warn(new Error(`Request ${id} not found`));
            return;
        }

        if (!invocation.ack) {
            this._onError(id, `Request ${id} not acknowledged`);
            return;
        }

        this._activeInvocations.delete(id);

        if (invocation.timer !== null) {
            clearTimeout(invocation.timer);
            invocation.timer = null;
        }

        const error = data.error;
        if (typeof error !== 'undefined') {
            invocation.reject(ExtensionError.deserialize(error));
        } else {
            invocation.resolve(data.result);
        }
    }

    /**
     * @param {number} id
     * @param {unknown} error
     */
    _onError(id, error) {
        const invocation = this._activeInvocations.get(id);
        if (typeof invocation === 'undefined') { return; }

        if (!(error instanceof Error)) {
            error = new Error(`${error} (${invocation.action})`);
        }

        this._activeInvocations.delete(id);
        if (invocation.timer !== null) {
            clearTimeout(invocation.timer);
            invocation.timer = null;
        }
        invocation.reject(error);
    }

    // Invocation

    /**
     * @param {number} id
     * @param {import('cross-frame-api').InvocationData} details
     * @returns {boolean}
     */
    _onInvoke(id, {action, params}) {
        const messageHandler = this._messageHandlers.get(action);
        this._sendAck(id);
        if (typeof messageHandler === 'undefined') {
            this._sendError(id, new Error(`Unknown action: ${action}`));
            return false;
        }

        /**
         * @param {import('core').Response<unknown>} data
         * @returns {void}
         */
        const callback = (data) => this._sendResult(id, data);
        return invokeMessageHandler(messageHandler, params, callback);
    }

    /**
     * @param {import('cross-frame-api').Message} data
     */
    _sendResponse(data) {
        if (this._port === null) { return; }
        try {
            this._port.postMessage(data);
        } catch (e) {
            // NOP
        }
    }

    /**
     * @param {number} id
     */
    _sendAck(id) {
        this._sendResponse({type: 'ack', id});
    }

    /**
     * @param {number} id
     * @param {import('core').Response<unknown>} data
     */
    _sendResult(id, data) {
        this._sendResponse({type: 'result', id, data});
    }

    /**
     * @param {number} id
     * @param {Error} error
     */
    _sendError(id, error) {
        this._sendResponse({type: 'result', id, data: {error: ExtensionError.serialize(error)}});
    }
}

export class CrossFrameAPI {
    constructor() {
        /** @type {number} */
        this._ackTimeout = 3000; // 3 seconds
        /** @type {number} */
        this._responseTimeout = 10000; // 10 seconds
        /** @type {Map<number, Map<number, CrossFrameAPIPort>>} */
        this._commPorts = new Map();
        /** @type {import('core').MessageHandlerMap} */
        this._messageHandlers = new Map();
        /** @type {(port: CrossFrameAPIPort) => void} */
        this._onDisconnectBind = this._onDisconnect.bind(this);
        /** @type {?number} */
        this._tabId = null;
        /** @type {?number} */
        this._frameId = null;
    }

    /** */
    async prepare() {
        chrome.runtime.onConnect.addListener(this._onConnect.bind(this));
        ({tabId: this._tabId = null, frameId: this._frameId = null} = await yomitan.api.frameInformationGet());
    }

    /**
     * @template [TParams=import('core').SerializableObject]
     * @template [TReturn=unknown]
     * @param {number} targetFrameId
     * @param {string} action
     * @param {TParams} params
     * @returns {Promise<TReturn>}
     */
    invoke(targetFrameId, action, params) {
        return this.invokeTab(null, targetFrameId, action, params);
    }

    /**
     * @template [TParams=import('core').SerializableObject]
     * @template [TReturn=unknown]
     * @param {?number} targetTabId
     * @param {number} targetFrameId
     * @param {string} action
     * @param {TParams} params
     * @returns {Promise<TReturn>}
     */
    async invokeTab(targetTabId, targetFrameId, action, params) {
        if (typeof targetTabId !== 'number') {
            targetTabId = this._tabId;
            if (typeof targetTabId !== 'number') {
                throw new Error('Unknown target tab id for invocation');
            }
        }
        const commPort = await this._getOrCreateCommPort(targetTabId, targetFrameId);
        return await commPort.invoke(action, params, this._ackTimeout, this._responseTimeout);
    }

    /**
     * @param {import('core').MessageHandlerMapInit} messageHandlers
     * @throws {Error}
     */
    registerHandlers(messageHandlers) {
        for (const [key, value] of messageHandlers) {
            if (this._messageHandlers.has(key)) {
                throw new Error(`Handler ${key} is already registered`);
            }
            this._messageHandlers.set(key, value);
        }
    }

    /**
     * @param {string} key
     * @returns {boolean}
     */
    unregisterHandler(key) {
        return this._messageHandlers.delete(key);
    }

    // Private

    /**
     * @param {chrome.runtime.Port} port
     */
    _onConnect(port) {
        try {
            /** @type {import('cross-frame-api').PortDetails} */
            let details;
            try {
                details = parseJson(port.name);
            } catch (e) {
                return;
            }
            if (details.name !== 'cross-frame-communication-port') { return; }

            const otherTabId = details.otherTabId;
            const otherFrameId = details.otherFrameId;
            this._setupCommPort(otherTabId, otherFrameId, port);
        } catch (e) {
            port.disconnect();
            log.error(e);
        }
    }

    /**
     * @param {CrossFrameAPIPort} commPort
     */
    _onDisconnect(commPort) {
        commPort.off('disconnect', this._onDisconnectBind);
        const {otherTabId, otherFrameId} = commPort;
        const tabPorts = this._commPorts.get(otherTabId);
        if (typeof tabPorts !== 'undefined') {
            tabPorts.delete(otherFrameId);
            if (tabPorts.size === 0) {
                this._commPorts.delete(otherTabId);
            }
        }
    }

    /**
     * @param {number} otherTabId
     * @param {number} otherFrameId
     * @returns {Promise<CrossFrameAPIPort>}
     */
    async _getOrCreateCommPort(otherTabId, otherFrameId) {
        const tabPorts = this._commPorts.get(otherTabId);
        if (typeof tabPorts !== 'undefined') {
            const commPort = tabPorts.get(otherFrameId);
            if (typeof commPort !== 'undefined') {
                return commPort;
            }
        }
        return await this._createCommPort(otherTabId, otherFrameId);
    }
    /**
     * @param {number} otherTabId
     * @param {number} otherFrameId
     * @returns {Promise<CrossFrameAPIPort>}
     */
    async _createCommPort(otherTabId, otherFrameId) {
        await yomitan.api.openCrossFramePort(otherTabId, otherFrameId);

        const tabPorts = this._commPorts.get(otherTabId);
        if (typeof tabPorts !== 'undefined') {
            const commPort = tabPorts.get(otherFrameId);
            if (typeof commPort !== 'undefined') {
                return commPort;
            }
        }
        throw new Error('Comm port didn\'t open');
    }

    /**
     * @param {number} otherTabId
     * @param {number} otherFrameId
     * @param {chrome.runtime.Port} port
     * @returns {CrossFrameAPIPort}
     */
    _setupCommPort(otherTabId, otherFrameId, port) {
        const commPort = new CrossFrameAPIPort(otherTabId, otherFrameId, port, this._messageHandlers);
        let tabPorts = this._commPorts.get(otherTabId);
        if (typeof tabPorts === 'undefined') {
            tabPorts = new Map();
            this._commPorts.set(otherTabId, tabPorts);
        }
        tabPorts.set(otherFrameId, commPort);
        commPort.prepare();
        commPort.on('disconnect', this._onDisconnectBind);
        return commPort;
    }
}
