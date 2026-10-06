package core

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Who a signed-in user is; the session only carries the ID.
type Profile struct {
	ID        string    `json:"id"`
	Provider  string    `json:"provider"`
	Login     string    `json:"login,omitempty"`
	Name      string    `json:"name,omitempty"`
	Email     string    `json:"email,omitempty"`
	Avatar    string    `json:"avatar,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	LastLogin time.Time `json:"lastLogin"`
}

// A GitHub account linked to a user; Token never leaves the server.
type GitHubLink struct {
	ID       int64     `json:"id"`
	Login    string    `json:"login"`
	Name     string    `json:"name,omitempty"`
	Email    string    `json:"email,omitempty"`
	Avatar   string    `json:"avatar,omitempty"`
	Scopes   string    `json:"scopes,omitempty"`
	Via      string    `json:"via"`
	LinkedAt time.Time `json:"linkedAt"`
	Token    string    `json:"-"`
}

var accountsMu sync.Mutex

// Hashed so a user ID never becomes a path.
func userRoot(user string) string {
	sum := sha256.Sum256([]byte(user))
	return filepath.Join(Cfg.DataDir, "users", hex.EncodeToString(sum[:8]))
}

func identitiesFile() string { return filepath.Join(Cfg.DataDir, "users", "identities.json") }

func writeJSONFile(path string, v interface{}) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readIdentities() map[string]string {
	m := map[string]string{}
	if data, err := os.ReadFile(identitiesFile()); err == nil {
		json.Unmarshal(data, &m)
	}
	return m
}

// Maps a provider identity to one user: the same identity first, then the same verified email, else a new user.
func ResolveUser(identity, email string) (string, error) {
	accountsMu.Lock()
	defer accountsMu.Unlock()
	ids := readIdentities()
	user := ids[identity]
	emailKey := ""
	if email = strings.ToLower(strings.TrimSpace(email)); email != "" {
		emailKey = "email:" + email
		if user == "" {
			user = ids[emailKey]
		}
	}
	if user == "" {
		user = "u-" + randomHex(16)
	}
	ids[identity] = user
	if emailKey != "" && ids[emailKey] == "" {
		ids[emailKey] = user
	}
	return user, writeJSONFile(identitiesFile(), ids)
}

// Points an identity at user unless another user already owns it; reports whether it now does.
func ClaimIdentity(identity, user string) (bool, error) {
	accountsMu.Lock()
	defer accountsMu.Unlock()
	ids := readIdentities()
	if owner := ids[identity]; owner != "" {
		return owner == user, nil
	}
	ids[identity] = user
	return true, writeJSONFile(identitiesFile(), ids)
}

func SaveProfile(p Profile) error {
	accountsMu.Lock()
	defer accountsMu.Unlock()
	path := filepath.Join(userRoot(p.ID), "profile.json")
	var old Profile
	if data, err := os.ReadFile(path); err == nil && json.Unmarshal(data, &old) == nil && !old.CreatedAt.IsZero() {
		p.CreatedAt = old.CreatedAt
	}
	if p.CreatedAt.IsZero() {
		p.CreatedAt = time.Now()
	}
	return writeJSONFile(path, p)
}

func GetProfile(user string) (Profile, bool) {
	data, err := os.ReadFile(filepath.Join(userRoot(user), "profile.json"))
	if err != nil {
		return Profile{}, false
	}
	var p Profile
	if json.Unmarshal(data, &p) != nil {
		return Profile{}, false
	}
	return p, true
}

// Per-user GitHub choices; a user who never touched them gets the defaults.
type Prefs struct {
	AutoPush        bool `json:"autoPush"`
	PrivateRepos    bool `json:"privateRepos"`
	AddCollaborator bool `json:"addCollaborator"`
}

func DefaultPrefs() Prefs { return Prefs{AutoPush: true, PrivateRepos: true, AddCollaborator: true} }

func GetPrefs(user string) Prefs {
	p := DefaultPrefs()
	if data, err := os.ReadFile(filepath.Join(userRoot(user), "prefs.json")); err == nil {
		json.Unmarshal(data, &p)
	}
	return p
}

func SavePrefs(user string, p Prefs) error {
	accountsMu.Lock()
	defer accountsMu.Unlock()
	return writeJSONFile(filepath.Join(userRoot(user), "prefs.json"), p)
}

type storedLink struct {
	GitHubLink
	Sealed string `json:"token"`
}

func githubFile(user string) string { return filepath.Join(userRoot(user), "github.json") }

func SaveGitHub(user string, link GitHubLink) error {
	sealed, err := sealSecret(link.Token)
	if err != nil {
		return err
	}
	if link.LinkedAt.IsZero() {
		link.LinkedAt = time.Now()
	}
	accountsMu.Lock()
	defer accountsMu.Unlock()
	return writeJSONFile(githubFile(user), storedLink{GitHubLink: link, Sealed: sealed})
}

func GetGitHub(user string) (GitHubLink, bool) {
	data, err := os.ReadFile(githubFile(user))
	if err != nil {
		return GitHubLink{}, false
	}
	var s storedLink
	if json.Unmarshal(data, &s) != nil {
		return GitHubLink{}, false
	}
	tok, err := openSecret(s.Sealed)
	if err != nil || tok == "" {
		return GitHubLink{}, false
	}
	s.GitHubLink.Token = tok
	return s.GitHubLink, true
}

func RemoveGitHub(user string) error {
	accountsMu.Lock()
	defer accountsMu.Unlock()
	err := os.Remove(githubFile(user))
	if os.IsNotExist(err) {
		return nil
	}
	return err
}

// Tokens are sealed with a key derived from the session secret, so a copied data dir alone does not leak them.
func secretKey() []byte {
	secret := Cfg.SessionSecret
	if len(secret) == 0 {
		secret = []byte(localSecret(Cfg.DataDir))
	}
	sum := sha256.Sum256(append([]byte("jr-token-seal|"), secret...))
	return sum[:]
}

func sealSecret(plain string) (string, error) {
	block, err := aes.NewCipher(secretKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	return base64.RawStdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plain), nil)), nil
}

func openSecret(sealed string) (string, error) {
	raw, err := base64.RawStdEncoding.DecodeString(sealed)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(secretKey())
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("sealed value too short")
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	return string(plain), err
}
