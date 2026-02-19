package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/celestiaorg/celestia-node/api/client"
	"github.com/celestiaorg/celestia-node/nodebuilder/p2p"
	"github.com/celestiaorg/celestia-node/state"
	libshare "github.com/celestiaorg/go-square/v3/share"
	"github.com/cosmos/cosmos-sdk/crypto/keyring"
)

const defaultTimeout = 120 * time.Second

type posterRequest struct {
	Action         string   `json:"action"`
	NamespaceIDB64 string   `json:"namespace_id_b64,omitempty"`
	DataB64        string   `json:"data_b64,omitempty"`
	GasPrice       *float64 `json:"gas_price,omitempty"`
	KeyName        string   `json:"key_name,omitempty"`
	SignerAddress  string   `json:"signer_address,omitempty"`
}

type coinBalance struct {
	Denom  string `json:"denom,omitempty"`
	Amount string `json:"amount,omitempty"`
}

type posterResponse struct {
	OK            bool         `json:"ok"`
	Mode          string       `json:"mode,omitempty"`
	PosterAddress string       `json:"poster_address,omitempty"`
	Balance       *coinBalance `json:"balance,omitempty"`
	TxHash        string       `json:"tx_hash,omitempty"`
	Height        uint64       `json:"height,omitempty"`
	Code          uint32       `json:"code,omitempty"`
	RawLog        string       `json:"raw_log,omitempty"`
	Error         string       `json:"error,omitempty"`
}

type runtimeConfig struct {
	DAURL          string
	DAAuthToken    string
	CoreGRPCAddr   string
	CoreAuthToken  string
	Network        p2p.Network
	KeyringDir     string
	KeyringBackend string
	DefaultKeyName string
	EnableDATLS    bool
	EnableCoreTLS  bool
	Timeout        time.Duration
}

func main() {
	resp, err := run()
	if err != nil {
		resp = posterResponse{
			OK:    false,
			Error: err.Error(),
		}
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(resp)

	if err != nil {
		os.Exit(1)
	}
}

func run() (posterResponse, error) {
	var req posterRequest
	decoder := json.NewDecoder(os.Stdin)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return posterResponse{}, fmt.Errorf("decode request from stdin: %w", err)
	}

	if req.Action == "" {
		req.Action = "status"
	}

	cfg, err := loadRuntimeConfig(req)
	if err != nil {
		return posterResponse{}, err
	}

	kr, keyName, err := openKeyring(cfg, req)
	if err != nil {
		return posterResponse{}, err
	}

	keyInfo, err := kr.Key(keyName)
	if err != nil {
		return posterResponse{}, fmt.Errorf("load key %q: %w", keyName, err)
	}
	address, err := keyInfo.GetAddress()
	if err != nil {
		return posterResponse{}, fmt.Errorf("get key address: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), cfg.Timeout)
	defer cancel()

	cl, err := client.New(ctx, client.Config{
		ReadConfig: client.ReadConfig{
			BridgeDAAddr: cfg.DAURL,
			DAAuthToken:  cfg.DAAuthToken,
			EnableDATLS:  cfg.EnableDATLS,
		},
		SubmitConfig: client.SubmitConfig{
			DefaultKeyName: keyName,
			Network:        cfg.Network,
			CoreGRPCConfig: client.CoreGRPCConfig{
				Addr:       cfg.CoreGRPCAddr,
				TLSEnabled: cfg.EnableCoreTLS,
				AuthToken:  cfg.CoreAuthToken,
			},
		},
	}, kr)
	if err != nil {
		return posterResponse{}, fmt.Errorf("init celestia client: %w", err)
	}
	defer cl.Close()

	resp := posterResponse{
		OK:            true,
		Mode:          req.Action,
		PosterAddress: address.String(),
	}

	switch req.Action {
	case "status":
		bal, err := cl.State.Balance(ctx)
		if err != nil {
			return posterResponse{}, fmt.Errorf("read poster balance: %w", err)
		}
		resp.Balance = &coinBalance{Denom: bal.Denom, Amount: bal.Amount.String()}
		return resp, nil

	case "submit":
		if req.NamespaceIDB64 == "" {
			return posterResponse{}, fmt.Errorf("namespace_id_b64 is required for submit")
		}
		if req.DataB64 == "" {
			return posterResponse{}, fmt.Errorf("data_b64 is required for submit")
		}

		namespace, err := parseNamespace(req.NamespaceIDB64)
		if err != nil {
			return posterResponse{}, fmt.Errorf("parse namespace_id_b64: %w", err)
		}

		data, err := base64.StdEncoding.DecodeString(req.DataB64)
		if err != nil {
			return posterResponse{}, fmt.Errorf("decode data_b64: %w", err)
		}
		blob, err := libshare.NewV0Blob(namespace, data)
		if err != nil {
			return posterResponse{}, fmt.Errorf("build blob: %w", err)
		}

		txConfig := state.NewTxConfig(txConfigOptions(req)...)
		txResp, err := cl.State.SubmitPayForBlob(ctx, []*libshare.Blob{blob}, txConfig)
		if err != nil {
			return posterResponse{}, fmt.Errorf("submit pay-for-blob tx: %w", err)
		}

		resp.TxHash = txResp.TxHash
		if txResp.Height > 0 {
			resp.Height = uint64(txResp.Height)
		}
		resp.Code = txResp.Code
		resp.RawLog = txResp.RawLog

		if txResp.Code != 0 {
			resp.OK = false
			resp.Error = fmt.Sprintf("celestia tx failed with code %d", txResp.Code)
		}

		bal, err := cl.State.Balance(ctx)
		if err == nil {
			resp.Balance = &coinBalance{Denom: bal.Denom, Amount: bal.Amount.String()}
		}

		return resp, nil

	default:
		return posterResponse{}, fmt.Errorf("unsupported action %q", req.Action)
	}
}

func txConfigOptions(req posterRequest) []state.ConfigOption {
	opts := make([]state.ConfigOption, 0, 3)
	if req.GasPrice != nil {
		opts = append(opts, state.WithGasPrice(*req.GasPrice))
	}
	if req.KeyName != "" {
		opts = append(opts, state.WithKeyName(req.KeyName))
	}
	if req.SignerAddress != "" {
		opts = append(opts, state.WithSignerAddress(req.SignerAddress))
	}
	return opts
}

func openKeyring(cfg runtimeConfig, req posterRequest) (keyring.Keyring, string, error) {
	keyName := cfg.DefaultKeyName
	if req.KeyName != "" {
		keyName = req.KeyName
	}

	kr, err := client.KeyringWithNewKey(client.KeyringConfig{
		KeyName:     keyName,
		BackendName: cfg.KeyringBackend,
	}, cfg.KeyringDir)
	if err != nil {
		return nil, "", fmt.Errorf("open keyring in %q: %w", cfg.KeyringDir, err)
	}
	return kr, keyName, nil
}

func loadRuntimeConfig(req posterRequest) (runtimeConfig, error) {
	daURL := strings.TrimSpace(os.Getenv("CELESTIA_GO_DA_URL"))
	if daURL == "" {
		return runtimeConfig{}, fmt.Errorf("CELESTIA_GO_DA_URL is required")
	}
	parsedDAURL, err := url.Parse(daURL)
	if err != nil {
		return runtimeConfig{}, fmt.Errorf("parse CELESTIA_GO_DA_URL: %w", err)
	}
	if parsedDAURL.Scheme == "" || parsedDAURL.Host == "" {
		return runtimeConfig{}, fmt.Errorf("CELESTIA_GO_DA_URL must include scheme and host")
	}

	daToken := strings.TrimSpace(os.Getenv("CELESTIA_GO_DA_AUTH_TOKEN"))
	if daToken == "" {
		daToken = deriveTokenFromPath(parsedDAURL.Path)
	}

	coreGRPCAddr := strings.TrimSpace(os.Getenv("CELESTIA_GO_CORE_GRPC_ADDR"))
	if coreGRPCAddr == "" {
		host := parsedDAURL.Hostname()
		if host == "" {
			return runtimeConfig{}, fmt.Errorf("unable to derive CELESTIA_GO_CORE_GRPC_ADDR from CELESTIA_GO_DA_URL")
		}
		coreGRPCAddr = host + ":9090"
	}

	coreToken := strings.TrimSpace(os.Getenv("CELESTIA_GO_CORE_AUTH_TOKEN"))
	if coreToken == "" {
		coreToken = daToken
	}

	network := strings.TrimSpace(os.Getenv("CELESTIA_GO_NETWORK"))
	if network == "" {
		network = "mocha-4"
	}

	keyringDir := strings.TrimSpace(os.Getenv("CELESTIA_GO_KEYRING_DIR"))
	if keyringDir == "" {
		keyringDir = ".celestia-poster-keys"
	}
	if !filepath.IsAbs(keyringDir) {
		wd, err := os.Getwd()
		if err != nil {
			return runtimeConfig{}, fmt.Errorf("read working directory: %w", err)
		}
		keyringDir = filepath.Join(wd, keyringDir)
	}

	keyringBackend := strings.TrimSpace(os.Getenv("CELESTIA_GO_KEYRING_BACKEND"))
	if keyringBackend == "" {
		keyringBackend = keyring.BackendTest
	}

	defaultKeyName := strings.TrimSpace(os.Getenv("CELESTIA_GO_KEY_NAME"))
	if defaultKeyName == "" {
		defaultKeyName = "x402_poster"
	}

	timeout := defaultTimeout
	if raw := strings.TrimSpace(os.Getenv("CELESTIA_GO_POSTER_TIMEOUT_MS")); raw != "" {
		timeoutMs, err := time.ParseDuration(raw + "ms")
		if err != nil {
			return runtimeConfig{}, fmt.Errorf("parse CELESTIA_GO_POSTER_TIMEOUT_MS: %w", err)
		}
		timeout = timeoutMs
	}

	return runtimeConfig{
		DAURL:          daURL,
		DAAuthToken:    daToken,
		CoreGRPCAddr:   coreGRPCAddr,
		CoreAuthToken:  coreToken,
		Network:        p2p.Network(network),
		KeyringDir:     keyringDir,
		KeyringBackend: keyringBackend,
		DefaultKeyName: defaultKeyName,
		EnableDATLS:    strings.EqualFold(parsedDAURL.Scheme, "https"),
		EnableCoreTLS:  strings.EqualFold(parsedDAURL.Scheme, "https"),
		Timeout:        timeout,
	}, nil
}

func deriveTokenFromPath(rawPath string) string {
	segments := strings.Split(rawPath, "/")
	for _, segment := range segments {
		trimmed := strings.TrimSpace(segment)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func parseNamespace(namespaceIDB64 string) (libshare.Namespace, error) {
	namespaceBytes, err := base64.StdEncoding.DecodeString(namespaceIDB64)
	if err != nil {
		return libshare.Namespace{}, fmt.Errorf("decode base64: %w", err)
	}

	switch len(namespaceBytes) {
	case 29:
		return libshare.NewNamespaceFromBytes(namespaceBytes)
	case 28:
		// Backward-compatible: JSON-RPC payloads may omit the 1-byte namespace version.
		versioned := make([]byte, 0, 29)
		versioned = append(versioned, 0)
		versioned = append(versioned, namespaceBytes...)
		return libshare.NewNamespaceFromBytes(versioned)
	case 10:
		// Support plain v0 sub-namespace IDs.
		return libshare.NewV0Namespace(namespaceBytes)
	default:
		return libshare.NewNamespaceFromBytes(namespaceBytes)
	}
}
