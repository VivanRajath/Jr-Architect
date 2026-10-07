package core

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Copies what the JSON files hold into MongoDB once, the first time a database is configured; the files are left in place.
func ImportFilesToDB() error {
	first, err := markOnce("files-import")
	if err != nil || !first {
		return err
	}
	users := map[string]bool{LocalUser: true}

	for identity, user := range readIdentities() {
		users[user] = true
		ctx, cancel := dbctx()
		_, err := coll(colIdentities).UpdateOne(ctx, bson.M{"_id": identity},
			bson.M{"$setOnInsert": bson.M{"user": user, "createdAt": time.Now()}}, options.UpdateOne().SetUpsert(true))
		cancel()
		if err != nil {
			return err
		}
	}

	dirs, _ := os.ReadDir(filepath.Join(Cfg.DataDir, "users"))
	for _, d := range dirs {
		if !d.IsDir() {
			continue
		}
		root := filepath.Join(Cfg.DataDir, "users", d.Name())
		var p Profile
		if data, err := os.ReadFile(filepath.Join(root, "profile.json")); err != nil || json.Unmarshal(data, &p) != nil || p.ID == "" {
			continue
		}
		users[p.ID] = true
		if err := saveProfileDB(p); err != nil {
			return err
		}
		var prefs Prefs
		if data, err := os.ReadFile(filepath.Join(root, "prefs.json")); err == nil && json.Unmarshal(data, &prefs) == nil {
			if err := setUserFields(p.ID, bson.M{"prefs": prefs}); err != nil {
				return err
			}
		}
		var link storedLink
		if data, err := os.ReadFile(filepath.Join(root, "github.json")); err == nil && json.Unmarshal(data, &link) == nil && link.Sealed != "" {
			if err := setUserFields(p.ID, bson.M{"github": link}); err != nil {
				return err
			}
		}
	}

	// Project folders are named by a hash of the owner, so owners are matched against every user known so far.
	byHash := map[string]string{}
	for u := range users {
		sum := sha256.Sum256([]byte(u))
		byHash[hex.EncodeToString(sum[:8])] = u
	}
	owners, _ := os.ReadDir(filepath.Join(Cfg.DataDir, "projects"))
	for _, o := range owners {
		owner, ok := byHash[o.Name()]
		if !ok {
			continue
		}
		projects, _ := os.ReadDir(filepath.Join(Cfg.DataDir, "projects", o.Name()))
		for _, pd := range projects {
			var p Project
			data, err := os.ReadFile(filepath.Join(Cfg.DataDir, "projects", o.Name(), pd.Name(), "meta.json"))
			if err != nil || json.Unmarshal(data, &p) != nil || !projectID.MatchString(pd.Name()) {
				continue
			}
			p.ID = pd.Name()
			ctx, cancel := dbctx()
			_, err = coll(colProjects).ReplaceOne(ctx, bson.M{"_id": p.ID}, projectDoc{Project: p, Owner: owner}, options.Replace().SetUpsert(true))
			cancel()
			if err != nil {
				return err
			}
		}
	}

	if saved := readSavedKeysFile(); len(saved) > 0 {
		if err := writeSavedKeysDB(saved); err != nil {
			return err
		}
	}
	Logf("db", "imported %d users from files", len(users)-1)
	return nil
}
