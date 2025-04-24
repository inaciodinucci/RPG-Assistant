// ==UserScript==
// @name        RPG-Assistant
// @namespace   RPG-Assistant
// @match       https://www.habblet.city/hotel*
// @grant       none
// @version     1.1
// @author      inaciodinucci
// @description Assistente para RPG no Habblet Hotel com suporte a troca de visuais
// ==/UserScript==

// Função para interceptar as comunicações WebSocket
function listen(callback) {
    callback = callback || console.log;
    let descriptor = Object.getOwnPropertyDescriptor(MessageEvent.prototype, "data");
    let originalGet = descriptor.get;

    descriptor.get = function interceptor() {
        if (!(this.currentTarget instanceof WebSocket)) return originalGet.call(this);

        let originalData = originalGet.call(this);
        Object.defineProperty(this, "data", { value: originalData });

        callback({
            data: originalData,
            target: this.currentTarget,
            event: this
        });

        return originalData;
    };

    Object.defineProperty(MessageEvent.prototype, "data", descriptor);
}

// Classe para leitura de dados binários
class BinaryReader {
    constructor(data) {
        this.data = data;
        this.view = new DataView(data);
        this.offset = 0;
    }

    readInt() {
        let value = this.view.getInt32(this.offset);
        this.offset += 4;
        return value;
    }

    readShort() {
        let value = this.view.getInt16(this.offset);
        this.offset += 2;
        return value;
    }

    readBoolean() {
        return !!this.data[this.offset++];
    }

    readString() {
        let length = this.readShort();
        let text = (new TextDecoder).decode(this.data.slice(this.offset, this.offset + length));
        this.offset += length;
        return text;
    }
}

// Classe para escrita de dados binários
class BinaryWriter {
    constructor(opcode) {
        this.data = [];
        this.offset = 0;
        this.writeInt(0);
        this.writeShort(opcode);
    }

    writeInt(value) {
        this.data[this.offset++] = (value >> 24) & 255;
        this.data[this.offset++] = (value >> 16) & 255;
        this.data[this.offset++] = (value >> 8) & 255;
        this.data[this.offset++] = value & 255;
        return this;
    }

    writeShort(value) {
        this.data[this.offset++] = (value >> 8) & 255;
        this.data[this.offset++] = value & 255;
        return this;
    }

    writeString(text) {
        let encoded = (new TextEncoder).encode(text);
        this.writeShort(encoded.length);

        for (let i = 0; i < encoded.length; i++) {
            this.data[this.offset + i] = encoded[i];
        }

        this.offset += encoded.length;
        return this;
    }

    getData() {
        this.offset = 0;
        this.writeInt(this.data.length - 4);
        return new Uint8Array(this.data).buffer;
    }
}

// Função para aguardar um tempo específico
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Estado global do RPG-Assistant
window.RPGAssistant = {
    elements: {},
    connection: {
        socket: null,
        sendOriginal: null,
        initialized: false
    },
    characters: [],
    currentFigure: null,
    userId: null,
    gender: 'M'
};

// Classe de personagem
class Character {
    constructor(name) {
        this.id = Date.now() + Math.floor(Math.random() * 1000);
        this.name = name || "Novo Personagem";
        this.figure = "";
        this.timestamp = Date.now();
    }

    save() {
        return {
            id: this.id,
            name: this.name,
            figure: this.figure,
            timestamp: this.timestamp
        };
    }

    static load(data) {
        const character = new Character();
        character.id = data.id;
        character.name = data.name;
        character.figure = data.figure;
        character.timestamp = data.timestamp;
        return character;
    }
}

// Gerenciamento de armazenamento local
const Storage = {
    save() {
        localStorage.setItem('rpgassistant_characters', JSON.stringify(
            window.RPGAssistant.characters.map(c => c.save())
        ));
    },

    load() {
        try {
            const data = localStorage.getItem('rpgassistant_characters');
            if (data) {
                window.RPGAssistant.characters = JSON.parse(data).map(Character.load);
            }
        } catch (e) {
            console.error("Error loading RPG Assistant data:", e);
            window.RPGAssistant.characters = [];
        }
    }
};

// Função principal de inicialização
async function initRPGAssistant() {
    const styleElement = document.createElement("style");
    styleElement.innerHTML = `
.rpg-assistant-button {
    position: fixed;
    left: 20px;
    top: 50%;
    transform: translateY(-50%);
    z-index: 9999;
    display: flex;
    flex-direction: column;
    align-items: center;
    cursor: pointer;
}

.rpg-assistant-icon {
    width: 36px;
    height: 36px;
    background-color: #6c757d;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-size: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    transition: background-color 0.2s ease;
}

.rpg-assistant-icon:hover {
    background-color: #5a6268;
}

.rpg-assistant-text {
    margin-top: 4px;
    font-size: 10px;
    font-weight: bold;
    font-family: 'Ubuntu', 'Verdana', 'Arial', 'Helvetica', sans-serif;
    color: #333;
    text-shadow: none;
    white-space: nowrap;
}

.rpg-assistant-panel {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 1000;
    width: 550px;
    color: #000;
    font-family: 'Ubuntu', 'Verdana', 'Arial', 'Helvetica', sans-serif;
    background-color: #fff;
    border: 1px solid #ccc;
    border-radius: 6px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
    display: none;
    overflow: hidden;
    flex-direction: column;
}

/* ... (mantenha o resto do CSS igual) ... */
    `;
    document.head.appendChild(styleElement);

    Storage.load();

    const mainButton = document.createElement("div");
    mainButton.className = "rpg-assistant-button";
    mainButton.innerHTML = `
        <div class="rpg-assistant-icon">⚔️</div>
        <div class="rpg-assistant-text">RPG Assistant</div>
    `;
    document.body.appendChild(mainButton);

    const panel = document.createElement("div");
    panel.className = "rpg-assistant-panel";
    panel.innerHTML = `
        <div class="rpg-assistant-header">
            <h2>RPG Assistant</h2>
            <div class="rpg-assistant-close">×</div>
        </div>
        <div class="rpg-assistant-menu">
            <div class="rpg-assistant-menu-item active" data-tab="characters">
                <span>👤</span> Personagens
            </div>
        </div>
        <div class="rpg-assistant-content">
            <div class="rpg-assistant-tab" id="characters-tab">
                <div class="rpg-assistant-characters-container">
                    <div class="rpg-assistant-add-character">
                        <div class="rpg-assistant-add-icon">+</div>
                        <div>Novo personagem</div>
                    </div>
                </div>
                <div id="character-editor-container"></div>
            </div>
        </div>
    `;
    document.body.appendChild(panel);

    window.RPGAssistant.elements = {
        mainButton,
        panel,
        charactersContainer: panel.querySelector('.rpg-assistant-characters-container'),
        editorContainer: panel.querySelector('#character-editor-container')
    };

    setupEventListeners();
    renderCharacters();
}

// Configuração dos ouvintes de eventos
function setupEventListeners() {
    const elements = window.RPGAssistant.elements;

    elements.mainButton.addEventListener('click', () => {
        elements.panel.style.display = elements.panel.style.display === 'none' ? 'block' : 'none';
    });

    elements.panel.querySelector('.rpg-assistant-close').addEventListener('click', () => {
        elements.panel.style.display = 'none';
    });

    elements.panel.querySelectorAll('.rpg-assistant-menu-item').forEach(item => {
        item.addEventListener('click', () => {
            elements.panel.querySelectorAll('.rpg-assistant-menu-item').forEach(i => {
                i.classList.remove('active');
            });

            item.classList.add('active');

            const tabId = item.getAttribute('data-tab');
            elements.panel.querySelectorAll('.rpg-assistant-tab').forEach(tab => {
                tab.style.display = 'none';
            });
            elements.panel.querySelector(`#${tabId}-tab`).style.display = 'block';
        });
    });

    elements.charactersContainer.querySelector('.rpg-assistant-add-character').addEventListener('click', () => {
        openCharacterEditor();
    });

    const header = elements.panel.querySelector('.rpg-assistant-header');
    let isDragging = false;
    let offsetX, offsetY;

    header.addEventListener('mousedown', (e) => {
        isDragging = true;
        const rect = elements.panel.getBoundingClientRect();
        offsetX = e.clientX - rect.left;
        offsetY = e.clientY - rect.top;
    });

    document.addEventListener('mousemove', (e) => {
        if (isDragging) {
            elements.panel.style.left = `${e.clientX - offsetX}px`;
            elements.panel.style.top = `${e.clientY - offsetY}px`;
            elements.panel.style.transform = 'none';
        }
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
    });
}

// Renderiza a lista de personagens
function renderCharacters() {
    const container = window.RPGAssistant.elements.charactersContainer;
    const addButton = container.querySelector('.rpg-assistant-add-character');

    Array.from(container.children).forEach(child => {
        if (!child.classList.contains('rpg-assistant-add-character')) {
            container.removeChild(child);
        }
    });

    window.RPGAssistant.characters.forEach(character => {
        const charElement = document.createElement('div');
        charElement.className = 'rpg-assistant-character';
        charElement.dataset.id = character.id;

        charElement.innerHTML = `
            <div class="rpg-assistant-character-figure">
                ${character.figure ? `<img src="https://www.habblet.city/habblet-imaging/avatarimage?figure=${character.figure}&size=m&direction=2&head_direction=3&gesture=sml&action=std" alt="${character.name}">` : ''}
            </div>
            <div class="rpg-assistant-character-info">
                <div class="rpg-assistant-character-name">${character.name}</div>
                <div class="rpg-assistant-character-buttons">
                    <button class="rpg-assistant-button-use">Utilizar</button>
                    <button class="rpg-assistant-button-edit">✏️</button>
                    <button class="rpg-assistant-button-delete">❌</button>
                </div>
            </div>
        `;

        charElement.querySelector('.rpg-assistant-button-use').addEventListener('click', () => {
            useCharacter(character.id);
        });

        charElement.querySelector('.rpg-assistant-button-edit').addEventListener('click', () => {
            openCharacterEditor(character.id);
        });

        charElement.querySelector('.rpg-assistant-button-delete').addEventListener('click', () => {
            deleteCharacter(character.id);
        });

        container.insertBefore(charElement, addButton);
    });
}

// Abre o editor de personagens
function openCharacterEditor(characterId = null) {
    const editorContainer = window.RPGAssistant.elements.editorContainer;
    let character = null;

    if (characterId) {
        character = window.RPGAssistant.characters.find(c => c.id === characterId);
        if (!character) return;
    }

    editorContainer.innerHTML = `
        <div class="rpg-assistant-character-editor">
            <div class="rpg-assistant-editor-header">
                <div class="rpg-assistant-editor-title">${character ? 'Editar Personagem' : 'Novo Personagem'}</div>
                <div class="rpg-assistant-editor-close">×</div>
            </div>
            <div class="rpg-assistant-editor-content">
                <div class="rpg-assistant-editor-figure">
                    ${character && character.figure ?
                        `<img src="https://www.habblet.city/habblet-imaging/avatarimage?figure=${character.figure}&size=m&direction=2&head_direction=3&gesture=sml&action=std" alt="${character.name}">` :
                        'Sem visual'}
                </div>
                <div class="rpg-assistant-editor-form">
                    <div class="rpg-assistant-editor-field">
                        <label class="rpg-assistant-editor-label">Nome do Personagem</label>
                        <input type="text" class="rpg-assistant-editor-input" id="character-name" value="${character ? character.name : 'Novo Personagem'}">
                    </div>
                    <div class="rpg-assistant-editor-buttons">
                        <button class="rpg-assistant-editor-button rpg-assistant-editor-button-copy" id="copy-figure-btn">Copiar Visual Atual</button>
                        <button class="rpg-assistant-editor-button rpg-assistant-editor-button-save" id="save-character-btn">Salvar</button>
                        <button class="rpg-assistant-editor-button rpg-assistant-editor-button-cancel" id="cancel-editor-btn">Cancelar</button>
                    </div>
                </div>
            </div>
        </div>
    `;

    editorContainer.querySelector('.rpg-assistant-editor-close').addEventListener('click', () => {
        closeCharacterEditor();
    });

    editorContainer.querySelector('#cancel-editor-btn').addEventListener('click', () => {
        closeCharacterEditor();
    });

    editorContainer.querySelector('#copy-figure-btn').addEventListener('click', () => {
        copyCurrentFigure();
    });

    editorContainer.querySelector('#save-character-btn').addEventListener('click', () => {
        saveCharacter(characterId);
    });
}

// Fecha o editor de personagens
function closeCharacterEditor() {
    window.RPGAssistant.elements.editorContainer.innerHTML = '';
}

// Copia o visual atual do usuário
async function copyCurrentFigure() {
    try {
        const figure = await getCurrentFigure();

        if (figure) {
            const editorFigure = window.RPGAssistant.elements.editorContainer.querySelector('.rpg-assistant-editor-figure');
            editorFigure.innerHTML = `<img src="https://www.habblet.city/habblet-imaging/avatarimage?figure=${figure}&size=m&direction=2&head_direction=3&gesture=sml&action=std">`;
            editorFigure.dataset.figure = figure;
        } else {
            alert('Não foi possível capturar o visual atual. Tente novamente.');
        }
    } catch (e) {
        console.error('Error copying figure:', e);
        alert('Erro ao copiar o visual atual.');
    }
}

// Obtém o visual atual do usuário
async function getCurrentFigure() {
    if (window.RPGAssistant.currentFigure) {
        return window.RPGAssistant.currentFigure;
    }

    const avatarImgElement = document.querySelector('img[src*="habblet-imaging"][src*="figure="]');

    if (avatarImgElement) {
        const src = avatarImgElement.src;
        const figureMatch = src.match(/figure=([^&]+)/);
        if (figureMatch && figureMatch[1]) {
            window.RPGAssistant.currentFigure = figureMatch[1];
            return figureMatch[1];
        }
    }

    if (window.RPGAssistant.connection.socket) {
        return new Promise((resolve) => {
            const checkTimeout = setTimeout(() => {
                resolve(null);
            }, 2000);

            const checkInterval = setInterval(() => {
                if (window.RPGAssistant.currentFigure) {
                    clearInterval(checkInterval);
                    clearTimeout(checkTimeout);
                    resolve(window.RPGAssistant.currentFigure);
                }
            }, 100);
        });
    }

    return null;
}

// Salva um personagem
function saveCharacter(characterId = null) {
    const editorContainer = window.RPGAssistant.elements.editorContainer;
    const nameInput = editorContainer.querySelector('#character-name');
    const figureElement = editorContainer.querySelector('.rpg-assistant-editor-figure');

    const name = nameInput.value.trim() || 'Novo Personagem';
    const figure = figureElement.dataset.figure || '';

    if (!figure) {
        alert('Por favor, copie um visual antes de salvar.');
        return;
    }

    if (characterId) {
        const index = window.RPGAssistant.characters.findIndex(c => c.id === characterId);
        if (index !== -1) {
            window.RPGAssistant.characters[index].name = name;
            window.RPGAssistant.characters[index].figure = figure;
        }
    } else {
        const character = new Character(name);
        character.figure = figure;
        window.RPGAssistant.characters.push(character);
    }

    Storage.save();
    renderCharacters();
    closeCharacterEditor();
}

// Exclui um personagem
function deleteCharacter(characterId) {
    if (confirm('Tem certeza que deseja excluir este personagem?')) {
        window.RPGAssistant.characters = window.RPGAssistant.characters.filter(c => c.id !== characterId);
        Storage.save();
        renderCharacters();
    }
}

// Usa um personagem aplicando seu visual
function useCharacter(characterId) {
    const character = window.RPGAssistant.characters.find(c => c.id === characterId);
    if (!character || !character.figure) return;

    applyFigure(character.figure);
}

// Aplica um visual ao avatar do usuário usando o pacote 374 (UNIT)
function applyFigure(figure) {
    if (!window.RPGAssistant.connection.socket) {
        alert('Erro: Não é possível aplicar o visual porque a conexão com o hotel não está disponível.');
        return;
    }

    try {
        const writer = new BinaryWriter(374); // Pacote UNIT (374)
        writer.writeInt(window.RPGAssistant.userId || 0); // ID do usuário
        writer.writeString(window.RPGAssistant.gender || 'M'); // Gênero (M/F)
        writer.writeString(figure); // Código do visual

        window.RPGAssistant.connection.socket.send(writer.getData());
        window.RPGAssistant.currentFigure = figure;
        window.RPGAssistant.elements.panel.style.display = 'none';

        console.log('Visual aplicado:', figure);
    } catch (e) {
        console.error('Error applying figure:', e);
        alert('Erro ao aplicar o visual. Por favor, tente novamente.');
    }
}

// Manipulador de pacotes WebSocket
function packetHandler({ data, target, event }) {
    if (!window.RPGAssistant.connection.initialized) {
        window.RPGAssistant.connection.socket = target;
        window.RPGAssistant.connection.sendOriginal = target.send;
        window.RPGAssistant.connection.initialized = true;

        target.send = function(data) {
            window.RPGAssistant.connection.sendOriginal.call(target, data);
        };
    }

    try {
        const reader = new BinaryReader(data);
        reader.readInt();
        const opcode = reader.readShort();

        if (opcode === 374) { // Pacote UNIT
            try {
                const userId = reader.readInt();
                const gender = reader.readString();
                const figure = reader.readString();

                if (figure && figure.length > 0) {
                    window.RPGAssistant.userId = userId;
                    window.RPGAssistant.gender = gender;
                    window.RPGAssistant.currentFigure = figure;
                }
            } catch (e) {
                console.error('Error parsing figure data:', e);
            }
        }

    } catch (e) {
        console.error('Error processing packet:', e);
    }

    return data;
}

// Inicializa o script
function initialize() {
    listen(packetHandler);

    const uiChecker = setInterval(() => {
        const navigationItem = document.querySelector(".navigation-item");
        if (navigationItem) {
            clearInterval(uiChecker);
            initRPGAssistant();
        }
    }, 100);
}

initialize();