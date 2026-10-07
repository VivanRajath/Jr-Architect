package core

import (
	"context"
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

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Who a signed-in user is; the session only carries the ID.
type Profile struct {
	ID        string    `json:"id" bson:"_id"`
	Provider  string    `json:"provider" bson:"provider"`
	Login     string    `json:"login,omitempty" bson:"login,omitempty"`
	Name      string    `json:"name,omitempty" bson:"name,omitempty"`
	Email     string    `json:"email,omitempty" bson:"email,omitempty"`
	Avatar    string    `json:"avatar,omitempty" bson:"avatar,omitempty"`
	CreatedAt time.Time `json:"createdAt" bson:"createdAt"`
	LastLogin time.Time `json:"lastLogin" bson:"lastLogin"`
}

// A GitHub account linked to a user; Token never leaves the server.
type GitHubLink struct {
	ID       int64     `json:"id" bson:"id"`
	Login    string    `json:"login" bson:"login"`
	Name     string    `json:"name,omitempty" bson:"name,omitempty"`
	Email    string    `json:"email,omitempty" bson:"email,omitempty"`
	Avatar   string    `json:"avatar,omitempty" bson:"avatar,omitempty"`
	Scopes   string    `json:"scopes,omitempty" bson:"scopes,omitempty"`
	Via      string    `json:"via" bson:"via"`
	LinkedAt time.Time `json:"linkedAt" bson:"linkedAt"`
	Token    string    `json:"-" bson:"-"`
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
	if DBEnabled() {
		return resolveUserDB(identity, email)
	}
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
	if DBEnabled() {
		return claimIdentityDB(identity, user)
	}
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
	if DBEnabled() {
		return saveProfileDB(p)
	}
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
	if DBEnabled() {
		var p Profile
		ctx, cancel := dbctx()
		defer cancel()
		if coll(colUsers).FindOne(ctx, bson.M{"_id": user}).Decode(&p) != nil || p.Provider == "" {
			return Profile{}, false
		}
		return p, true
	}
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
	AutoPush        bool `json:"autoPush" bson:"autoPush"`
	PrivateRepos    bool `json:"privateRepos" bson:"privateRepos"`
	AddCollaborator bool `json:"addCollaborator" bson:"addCollaborator"`
}

func DefaultPrefs() Prefs { return Prefs{AutoPush: true, PrivateRepos: true, AddCollaborator: true} }

func GetPrefs(user string) Prefs {
	p := DefaultPrefs()
	if DBEnabled() {
		var doc struct {
			Prefs *Prefs `bson:"prefs"`
		}
		ctx, cancel := dbctx()
		defer cancel()
		if coll(colUsers).FindOne(ctx, bson.M{"_id": user}).Decode(&doc) == nil && doc.Prefs != nil {
			p = *doc.Prefs
		}
		return p
	}
	if data, err := os.ReadFile(filepath.Join(userRoot(user), "prefs.json")); err == nil {
		json.Unmarshal(data, &p)
	}
	return p
}

func SavePrefs(user string, p Prefs) error {
	accountsMu.Lock()
	defer accountsMu.Unlock()
	if DBEnabled() {
		return setUserFields(user, bson.M{"prefs": p})
	}
	return writeJSONFile(filepath.Join(userRoot(user), "prefs.json"), p)
}

type storedLink struct {
	GitHubLink `bson:",inline"`
	Sealed     string `json:"token" bson:"token"`
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
	if DBEnabled() {
		return setUserFields(user, bson.M{"github": storedLink{GitHubLink: link, Sealed: sealed}})
	}
	return writeJSONFile(githubFile(user), storedLink{GitHubLink: link, Sealed: sealed})
}

func GetGitHub(user string) (GitHubLink, bool) {
	var s storedLink
	if DBEnabled() {
		var doc struct {
			GitHub *storedLink `bson:"github"`
		}
		ctx, cancel := dbctx()
		defer cancel()
		if coll(colUsers).FindOne(ctx, bson.M{"_id": user}).Decode(&doc) != nil || doc.GitHub == nil {
			return GitHubLink{}, false
		}
		s = *doc.GitHub
	} else {
		data, err := os.ReadFile(githubFile(user))
		if err != nil || json.Unmarshal(data, &s) != nil {
			return GitHubLink{}, false
		}
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
	if DBEnabled() {
		ctx, cancel := dbctx()
		defer cancel()
		_, err := coll(colUsers).UpdateOne(ctx, bson.M{"_id": user}, bson.M{"$unset": bson.M{"github": ""}, "$set": bson.M{"updatedAt": time.Now()}})
		return err
	}
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

// Upserts fields on a user's document, creating the document the first time.
func setUserFields(user string, fields bson.M) error {
	ctx, cancel := dbctx()
	defer cancel()
	fields["updatedAt"] = time.Now()
	_, err := coll(colUsers).UpdateOne(ctx, bson.M{"_id": user},
		bson.M{"$set": fields, "$setOnInsert": bson.M{"createdAt": time.Now()}}, options.UpdateOne().SetUpsert(true))
	return err
}

func identityOwner(ctx context.Context, identity string) string {
	var doc struct {
		User string `bson:"user"`
	}
	if coll(colIdentities).FindOne(ctx, bson.M{"_id": identity}).Decode(&doc) != nil {
		return ""
	}
	return doc.User
}

func resolveUserDB(identity, email string) (string, error) {
	ctx, cancel := dbctx()
	defer cancel()
	user := identityOwner(ctx, identity)
	emailKey := ""
	if email = strings.ToLower(strings.TrimSpace(email)); email != "" {
		emailKey = "email:" + email
		if user == "" {
			user = identityOwner(ctx, emailKey)
		}
	}
	if user == "" {
		user = "u-" + randomHex(16)
	}
	now := time.Now()
	if _, err := coll(colIdentities).UpdateOne(ctx, bson.M{"_id": identity},
		bson.M{"$set": bson.M{"user": user, "updatedAt": now}, "$setOnInsert": bson.M{"createdAt": now}}, options.UpdateOne().SetUpsert(true)); err != nil {
		return "", err
	}
	if emailKey != "" {
		if _, err := coll(colIdentities).UpdateOne(ctx, bson.M{"_id": emailKey},
			bson.M{"$setOnInsert": bson.M{"user": user, "createdAt": now}}, options.UpdateOne().SetUpsert(true)); err != nil {
			return "", err
		}
	}
	return user, nil
}

func claimIdentityDB(identity, user string) (bool, error) {
	ctx, cancel := dbctx()
	defer cancel()
	_, err := coll(colIdentities).InsertOne(ctx, bson.M{"_id": identity, "user": user, "createdAt": time.Now()})
	if mongo.IsDuplicateKeyError(err) {
		return identityOwner(ctx, identity) == user, nil
	}
	return err == nil, err
}

func saveProfileDB(p Profile) error {
	ctx, cancel := dbctx()
	defer cancel()
	now := time.Now()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	set := bson.M{"provider": p.Provider, "login": p.Login, "name": p.Name, "email": p.Email, "avatar": p.Avatar, "lastLogin": p.LastLogin, "updatedAt": now}
	_, err := coll(colUsers).UpdateOne(ctx, bson.M{"_id": p.ID},
		bson.M{"$set": set, "$setOnInsert": bson.M{"createdAt": p.CreatedAt}}, options.UpdateOne().SetUpsert(true))
	return err
}

// Gives a beta-code user a record too, so every user has one; an existing profile only gets its login time bumped.
func RecordBetaUser(user string) {
	p, ok := GetProfile(user)
	if !ok {
		p = Profile{ID: user, Provider: "beta"}
	}
	p.LastLogin = time.Now()
	if err := SaveProfile(p); err != nil {
		Logf("auth", "recording user %s: %v", user, err)
	}
}
