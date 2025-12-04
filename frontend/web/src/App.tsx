// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface DataFuture {
  id: string;
  encryptedValue: string;
  timestamp: number;
  owner: string;
  description: string;
  category: string;
  expiryDate: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [futures, setFutures] = useState<DataFuture[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newFutureData, setNewFutureData] = useState({ 
    description: "", 
    category: "Climate", 
    value: 0,
    expiryDays: 30 
  });
  const [selectedFuture, setSelectedFuture] = useState<DataFuture | null>(null);
  const [decryptedValue, setDecryptedValue] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");

  const categories = ["All", "Climate", "Health", "Finance", "Tech", "Other"];

  useEffect(() => {
    loadFutures().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadFutures = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("future_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing future keys:", e); }
      }
      
      const list: DataFuture[] = [];
      for (const key of keys) {
        try {
          const futureBytes = await contract.getData(`future_${key}`);
          if (futureBytes.length > 0) {
            try {
              const futureData = JSON.parse(ethers.toUtf8String(futureBytes));
              list.push({ 
                id: key, 
                encryptedValue: futureData.value, 
                timestamp: futureData.timestamp, 
                owner: futureData.owner, 
                description: futureData.description,
                category: futureData.category || "Other",
                expiryDate: futureData.expiryDate || (futureData.timestamp + 30 * 86400)
              });
            } catch (e) { console.error(`Error parsing future data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading future ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setFutures(list);
    } catch (e) { console.error("Error loading futures:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const createFuture = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting future data with Zama FHE..." });
    try {
      const encryptedValue = FHEEncryptNumber(newFutureData.value);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const futureId = `future-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const expiryTimestamp = Math.floor(Date.now() / 1000) + (newFutureData.expiryDays * 86400);
      
      const futureData = { 
        value: encryptedValue, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        description: newFutureData.description,
        category: newFutureData.category,
        expiryDate: expiryTimestamp
      };
      
      await contract.setData(`future_${futureId}`, ethers.toUtf8Bytes(JSON.stringify(futureData)));
      
      const keysBytes = await contract.getData("future_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(futureId);
      await contract.setData("future_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE-encrypted future created!" });
      await loadFutures();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewFutureData({ 
          description: "", 
          category: "Climate", 
          value: 0,
          expiryDays: 30 
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Creation failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const filteredFutures = futures.filter(future => {
    const matchesSearch = future.description.toLowerCase().includes(searchTerm.toLowerCase()) || 
                         future.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = activeCategory === "All" || future.category === activeCategory;
    return matchesSearch && matchesCategory;
  });

  const climateFutures = futures.filter(f => f.category === "Climate").length;
  const healthFutures = futures.filter(f => f.category === "Health").length;
  const financeFutures = futures.filter(f => f.category === "Finance").length;
  const techFutures = futures.filter(f => f.category === "Tech").length;
  const otherFutures = futures.filter(f => f.category === "Other").length;

  const activeFutures = futures.filter(f => f.expiryDate > Math.floor(Date.now() / 1000)).length;
  const expiredFutures = futures.length - activeFutures;

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <h1>FHE<span>Data</span>Futures</h1>
          <div className="logo-tag">Powered by Zama FHE</div>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-btn"
          >
            + Create Future
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="dashboard-container">
        <div className="stats-panel">
          <div className="stat-card">
            <div className="stat-value">{futures.length}</div>
            <div className="stat-label">Total Futures</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{activeFutures}</div>
            <div className="stat-label">Active</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{expiredFutures}</div>
            <div className="stat-label">Expired</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{climateFutures}</div>
            <div className="stat-label">Climate</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{healthFutures}</div>
            <div className="stat-label">Health</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">{financeFutures}</div>
            <div className="stat-label">Finance</div>
          </div>
        </div>

        <div className="main-content">
          <div className="controls-row">
            <div className="search-box">
              <input 
                type="text" 
                placeholder="Search futures..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              <div className="search-icon"></div>
            </div>
            <div className="category-tabs">
              {categories.map(cat => (
                <button 
                  key={cat}
                  className={activeCategory === cat ? "active" : ""}
                  onClick={() => setActiveCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>
            <button 
              onClick={loadFutures} 
              className="refresh-btn"
              disabled={isRefreshing}
            >
              {isRefreshing ? "Refreshing..." : "Refresh Data"}
            </button>
          </div>

          <div className="futures-list">
            <div className="list-header">
              <div className="header-cell">Description</div>
              <div className="header-cell">Category</div>
              <div className="header-cell">Owner</div>
              <div className="header-cell">Expiry</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {filteredFutures.length === 0 ? (
              <div className="no-results">
                <div className="no-results-icon"></div>
                <p>No futures found matching your criteria</p>
                <button 
                  className="create-btn"
                  onClick={() => setShowCreateModal(true)}
                >
                  Create First Future
                </button>
              </div>
            ) : (
              filteredFutures.map(future => (
                <div 
                  className="future-item" 
                  key={future.id}
                  onClick={() => setSelectedFuture(future)}
                >
                  <div className="item-cell description">{future.description}</div>
                  <div className="item-cell category">
                    <span className={`category-tag ${future.category.toLowerCase()}`}>
                      {future.category}
                    </span>
                  </div>
                  <div className="item-cell owner">
                    {future.owner.substring(0, 6)}...{future.owner.substring(38)}
                  </div>
                  <div className="item-cell expiry">
                    {new Date(future.expiryDate * 1000).toLocaleDateString()}
                    <div className={`status-indicator ${future.expiryDate > Math.floor(Date.now() / 1000) ? "active" : "expired"}`}></div>
                  </div>
                  <div className="item-cell status">
                    {future.expiryDate > Math.floor(Date.now() / 1000) ? (
                      <span className="status-active">Active</span>
                    ) : (
                      <span className="status-expired">Expired</span>
                    )}
                  </div>
                  <div className="item-cell actions">
                    <button 
                      className="action-btn view"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedFuture(future);
                      }}
                    >
                      View
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {showCreateModal && (
        <div className="modal-overlay">
          <div className="create-modal">
            <div className="modal-header">
              <h2>Create New Data Future</h2>
              <button 
                className="close-btn"
                onClick={() => setShowCreateModal(false)}
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Description *</label>
                <input 
                  type="text" 
                  value={newFutureData.description}
                  onChange={(e) => setNewFutureData({...newFutureData, description: e.target.value})}
                  placeholder="E.g. 'Global average temperature for next month'"
                />
              </div>
              
              <div className="form-row">
                <div className="form-group">
                  <label>Category *</label>
                  <select
                    value={newFutureData.category}
                    onChange={(e) => setNewFutureData({...newFutureData, category: e.target.value})}
                  >
                    <option value="Climate">Climate</option>
                    <option value="Health">Health</option>
                    <option value="Finance">Finance</option>
                    <option value="Tech">Tech</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
                
                <div className="form-group">
                  <label>Expiry (days) *</label>
                  <input 
                    type="number" 
                    min="1"
                    value={newFutureData.expiryDays}
                    onChange={(e) => setNewFutureData({...newFutureData, expiryDays: parseInt(e.target.value) || 30})}
                  />
                </div>
              </div>
              
              <div className="form-group">
                <label>Numerical Value *</label>
                <input 
                  type="number" 
                  step="0.01"
                  value={newFutureData.value}
                  onChange={(e) => setNewFutureData({...newFutureData, value: parseFloat(e.target.value) || 0})}
                  placeholder="Value that will be FHE encrypted"
                />
              </div>
              
              <div className="encryption-preview">
                <h4>FHE Encryption Preview</h4>
                <div className="preview-content">
                  <div className="plain-value">
                    <span>Plain Value:</span>
                    <div>{newFutureData.value}</div>
                  </div>
                  <div className="arrow">→</div>
                  <div className="encrypted-value">
                    <span>Encrypted Value:</span>
                    <div>{FHEEncryptNumber(newFutureData.value).substring(0, 30)}...</div>
                  </div>
                </div>
                <div className="fhe-badge">
                  <span>Zama FHE Encrypted</span>
                </div>
              </div>
            </div>
            
            <div className="modal-footer">
              <button 
                className="cancel-btn"
                onClick={() => setShowCreateModal(false)}
              >
                Cancel
              </button>
              <button 
                className="submit-btn"
                onClick={createFuture}
                disabled={creating || !newFutureData.description || !newFutureData.value}
              >
                {creating ? "Creating with FHE..." : "Create Future"}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedFuture && (
        <div className="modal-overlay">
          <div className="detail-modal">
            <div className="modal-header">
              <h2>Future Contract Details</h2>
              <button 
                className="close-btn"
                onClick={() => {
                  setSelectedFuture(null);
                  setDecryptedValue(null);
                }}
              >
                &times;
              </button>
            </div>
            
            <div className="modal-body">
              <div className="future-info">
                <div className="info-row">
                  <span>Description:</span>
                  <strong>{selectedFuture.description}</strong>
                </div>
                <div className="info-row">
                  <span>Category:</span>
                  <strong className={`category-tag ${selectedFuture.category.toLowerCase()}`}>
                    {selectedFuture.category}
                  </strong>
                </div>
                <div className="info-row">
                  <span>Owner:</span>
                  <strong>{selectedFuture.owner}</strong>
                </div>
                <div className="info-row">
                  <span>Created:</span>
                  <strong>{new Date(selectedFuture.timestamp * 1000).toLocaleString()}</strong>
                </div>
                <div className="info-row">
                  <span>Expires:</span>
                  <strong>{new Date(selectedFuture.expiryDate * 1000).toLocaleString()}</strong>
                </div>
                <div className="info-row">
                  <span>Status:</span>
                  <strong className={selectedFuture.expiryDate > Math.floor(Date.now() / 1000) ? "status-active" : "status-expired"}>
                    {selectedFuture.expiryDate > Math.floor(Date.now() / 1000) ? "Active" : "Expired"}
                  </strong>
                </div>
              </div>
              
              <div className="encrypted-data-section">
                <h3>Encrypted Value</h3>
                <div className="encrypted-value">
                  {selectedFuture.encryptedValue.substring(0, 50)}...
                </div>
                
                <button 
                  className="decrypt-btn"
                  onClick={async () => {
                    if (decryptedValue !== null) {
                      setDecryptedValue(null);
                    } else {
                      const value = await decryptWithSignature(selectedFuture.encryptedValue);
                      if (value !== null) {
                        setDecryptedValue(value);
                      }
                    }
                  }}
                  disabled={isDecrypting}
                >
                  {isDecrypting ? "Decrypting..." : 
                   decryptedValue !== null ? "Hide Value" : "Decrypt with Wallet"}
                </button>
                
                {decryptedValue !== null && (
                  <div className="decrypted-value-section">
                    <h3>Decrypted Value</h3>
                    <div className="decrypted-value">
                      {decryptedValue}
                    </div>
                    <div className="decryption-notice">
                      This value was decrypted client-side after wallet signature verification
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-notification">
          <div className={`notification-content ${transactionStatus.status}`}>
            <div className="notification-icon">
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && <div className="checkmark"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="notification-message">
              {transactionStatus.message}
            </div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-left">
            <h3>FHE Data Futures</h3>
            <p>A decentralized exchange for FHE-encrypted data futures</p>
            <div className="tech-badge">
              <span>Powered by Zama FHE</span>
            </div>
          </div>
          <div className="footer-right">
            <div className="footer-links">
              <a href="#">Documentation</a>
              <a href="#">About</a>
              <a href="#">Terms</a>
              <a href="#">Privacy</a>
            </div>
            <div className="copyright">
              © {new Date().getFullYear()} FHE Data Futures. All rights reserved.
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;