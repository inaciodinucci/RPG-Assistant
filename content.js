// ==UserScript==
// @name        RPG-Assistant
// @namespace   RPG-Assistant
// @match       https://www.habblet.city/hotel*
// @grant       none
// @version     1.0
// @author      inaciodinucci
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
    currentFigure: null
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

.rpg-assistant-header {

    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 15px; 
    border-bottom: 1px solid #dee2e6; 
    cursor: move;
    background-color: #f8f9fa; 
    border-radius: 6px 6px 0 0; 
    color: #333; 
}

.rpg-assistant-header h2 {
    margin: 0;
    font-size: 16px; 
    font-weight: bold;
}

.rpg-assistant-close {
    cursor: pointer;
    font-size: 24px; 
    font-weight: bold;
    color: #6c757d; 
    line-height: 1;
    padding: 0 5px; 
}

.rpg-assistant-close:hover {
    color: #dc3545; 
}

.rpg-assistant-menu {

    display: flex;
    border-bottom: 1px solid #dee2e6;
    padding: 0 10px; 
    background-color: #f8f9fa; 
}

.rpg-assistant-menu-item {
    padding: 10px 15px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px; 
    font-size: 14px; 
    color: #333;
    border-bottom: 3px solid transparent; 
    margin-bottom: -1px; 
}

.rpg-assistant-menu-item:hover {
    background-color: #e9ecef; 
    color: #000;
}

.rpg-assistant-menu-item.active {
    border-bottom: 3px solid #0d6efd; 
    font-weight: bold;
    color: #000;
}

.rpg-assistant-content {

    padding: 15px;
    max-height: 450px; 
    overflow-y: auto;
    background-color: #fff; 
    color: #000; 
}

.rpg-assistant-content::-webkit-scrollbar {
    width: 8px;
}
.rpg-assistant-content::-webkit-scrollbar-track {
    background: #f1f1f1;
    border-radius: 4px;
}
.rpg-assistant-content::-webkit-scrollbar-thumb {
    background: #ccc;
    border-radius: 4px;
}
.rpg-assistant-content::-webkit-scrollbar-thumb:hover {
    background: #aaa;
}

.rpg-assistant-characters-container {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); 
    gap: 10px; 
    padding: 10px 0;
}

.rpg-assistant-character {
    background-color: #f8f9fa; 
    border-radius: 6px;
    border: 1px solid #dee2e6; 
    overflow: hidden;
    transition: all 0.2s ease;
    display: flex;
    flex-direction: column; 
}

.rpg-assistant-character:hover {
    transform: translateY(-2px);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1); 
    border-color: #adb5bd; 
}

.rpg-assistant-character-figure {
    height: 110px;
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: #e9ecef; 
    border-bottom: 1px solid #dee2e6; 
}
.rpg-assistant-character-figure img {
    max-width: 100%;
    max-height: 100%;
}

.rpg-assistant-character-info {
    padding: 10px; 
    display: flex;
    flex-direction: column;
    gap: 8px; 
}

.rpg-assistant-character-name {
    font-size: 13px; 
    font-weight: bold;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: center;
    color: #000; 
}

.rpg-assistant-character-buttons {
    display: flex;
    gap: 5px; 
}

.rpg-assistant-button-use,
.rpg-assistant-button-edit,
.rpg-assistant-button-delete {

    display: inline-block;
    font-weight: 400;
    line-height: 1.5;
    color: #fff; 
    text-align: center;
    text-decoration: none;
    vertical-align: middle;
    cursor: pointer;
    user-select: none;
    background-color: transparent;
    border: 1px solid transparent;
    padding: 0.25rem 0.5rem; 
    font-size: 0.875rem; 
    border-radius: 0.2rem; 
    transition: color .15s ease-in-out, background-color .15s ease-in-out, border-color .15s ease-in-out, box-shadow .15s ease-in-out;
}

.rpg-assistant-button-use {
    flex-grow: 1; 
    background-color: #0d6efd; 
    border-color: #0d6efd;
}
.rpg-assistant-button-use:hover {
    background-color: #0b5ed7;
    border-color: #0a58ca;
}

.rpg-assistant-button-edit {
    width: auto; 
    height: auto; 
    background-color: #6c757d; 
    border-color: #6c757d;
    padding: 0.25rem 0.6rem; 
}
.rpg-assistant-button-edit:hover {
    background-color: #5c636a;
    border-color: #565e64;
}

.rpg-assistant-button-delete {
    width: auto; 
    height: auto; 
    background-color: #dc3545; 
    border-color: #dc3545;
    padding: 0.25rem 0.6rem; 
}
.rpg-assistant-button-delete:hover {
    background-color: #bb2d3b;
    border-color: #b02a37;
}

.rpg-assistant-add-character {
    min-height: 160px; 
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background-color: #f8f9fa;
    border: 2px dashed #ced4da; 
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s ease;
    color: #6c757d; 
    font-size: 13px;
    text-align: center;
}

.rpg-assistant-add-character:hover {
    background-color: #e9ecef;
    border-color: #adb5bd;
    color: #333;
}

.rpg-assistant-add-icon {
    font-size: 30px; 
    margin-bottom: 8px;
}

.rpg-assistant-character-editor {
    background-color: #f8f9fa; 
    padding: 15px;
    border-radius: 6px;
    margin-top: 20px; 
    border: 1px solid #dee2e6; 
    color: #000; 
}

.rpg-assistant-editor-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 15px;
    padding-bottom: 10px; 
    border-bottom: 1px solid #dee2e6; 
}

.rpg-assistant-editor-title {
    font-size: 16px;
    font-weight: bold;
}

.rpg-assistant-editor-close {
    cursor: pointer;
    font-size: 22px; 
    font-weight: bold;
    color: #6c757d;
    line-height: 1;
}
.rpg-assistant-editor-close:hover {
    color: #dc3545;
}

.rpg-assistant-editor-content {
    display: flex;
    gap: 20px; 
}

.rpg-assistant-editor-figure {
    width: 120px;
    height: 130px; 
    background-color: #e9ecef; 
    border-radius: 4px;
    border: 1px solid #dee2e6; 
    display: flex;
    align-items: center;
    justify-content: center;
    color: #6c757d; 
    flex-shrink: 0; 
}
.rpg-assistant-editor-figure img {
    max-width: 100%;
    max-height: 100%;
}

.rpg-assistant-editor-form {
    flex-grow: 1;
}

.rpg-assistant-editor-field {
    margin-bottom: 15px; 
}

.rpg-assistant-editor-label {
    display: block;
    margin-bottom: 5px;
    font-size: 13px; 
    font-weight: bold; 
    color: #333; 
}

.rpg-assistant-editor-input {

    display: block;
    width: 100%;
    padding: 0.375rem 0.75rem;
    font-size: 1rem;
    font-weight: 400;
    line-height: 1.5;
    color: #212529;
    background-color: #fff;
    background-clip: padding-box;
    border: 1px solid #ced4da;
    appearance: none;
    border-radius: 0.25rem;
    transition: border-color .15s ease-in-out, box-shadow .15s ease-in-out;
}
.rpg-assistant-editor-input:focus {
    color: #212529;
    background-color: #fff;
    border-color: #86b7fe;
    outline: 0;
    box-shadow: 0 0 0 0.25rem rgba(13, 110, 253, 0.25);
}

.rpg-assistant-editor-buttons {
    display: flex;
    gap: 10px; 
    margin-top: 20px; 
    justify-content: flex-end; 
}

.rpg-assistant-editor-button {

    display: inline-block;
    font-weight: 400;
    line-height: 1.5;
    color: #fff;
    text-align: center;
    text-decoration: none;
    vertical-align: middle;
    cursor: pointer;
    user-select: none;
    background-color: transparent;
    border: 1px solid transparent;
    padding: 0.375rem 0.75rem; 
    font-size: 1rem; 
    border-radius: 0.25rem; 
    transition: color .15s ease-in-out, background-color .15s ease-in-out, border-color .15s ease-in-out, box-shadow .15s ease-in-out;
}

.rpg-assistant-editor-button-copy {
    background-color: #198754; 
    border-color: #198754;
}
.rpg-assistant-editor-button-copy:hover {
    background-color: #157347;
    border-color: #146c43;
}

.rpg-assistant-editor-button-save {
    background-color: #0d6efd; 
    border-color: #0d6efd;
}
.rpg-assistant-editor-button-save:hover {
    background-color: #0b5ed7;
    border-color: #0a58ca;
}

.rpg-assistant-editor-button-cancel {
    background-color: #6c757d; 
    border-color: #6c757d;
    color: #fff;
}
.rpg-assistant-editor-button-cancel:hover {
    background-color: #5c636a;
    border-color: #565e64;
}

.fw-bold { font-weight: bold; }
.text-black { color: #000 !important; }
.d-flex { display: flex !important; }
.gap-1 { gap: 0.25rem !important; }
.gap-2 { gap: 0.5rem !important; }
.gap-3 { gap: 1rem !important; }
.align-items-center { align-items: center !important; }
.justify-content-between { justify-content: space-between !important; }
.justify-content-center { justify-content: center !important; }
.flex-column { flex-direction: column !important; }


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
                ${character.figure ? `<img src="https://www.habbo.com/habbo-imaging/avatarimage?figure=${character.figure}&size=m&direction=2&head_direction=3&gesture=sml&action=std" alt="${character.name}">` : ''}
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
                        `<img src="https://www.habbo.com/habbo-imaging/avatarimage?figure=${character.figure}&size=m&direction=2&head_direction=3&gesture=sml&action=std" alt="${character.name}">` : 
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
            editorFigure.innerHTML = `<img src="https://www.habbo.com/habbo-imaging/avatarimage?figure=${figure}&size=m&direction=2&head_direction=3&gesture=sml&action=std">`;
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
    
    const avatarImgElement = document.querySelector('img[src*="habbo-imaging"][src*="figure="]');
    
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

// Aplica um visual ao avatar do usuário
async function applyFigure(figure) {
    if (!window.RPGAssistant.connection.socket) {
        alert('Erro: Não é possível aplicar o visual porque a conexão com o hotel não está disponível.');
        return;
    }
    
    try {
        const writer = new BinaryWriter(2730);
        writer.writeString(figure);
        writer.writeString("");
        
        window.RPGAssistant.connection.socket.send(writer.getData());
        
        window.RPGAssistant.currentFigure = figure;
        
        window.RPGAssistant.elements.panel.style.display = 'none';
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
        
        if (opcode === 1640) {
            try {
                reader.readInt();
                const figure = reader.readString();
                
                if (figure && figure.length > 0) {
                    window.RPGAssistant.currentFigure = figure;
                }
            } catch (e) {
                console.error('Error parsing figure data:', e);
            }
        }
        
    } catch (e) {
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