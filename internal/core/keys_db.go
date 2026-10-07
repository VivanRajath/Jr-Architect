package core

import (
	"sort"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// One document per saved provider key; the key itself is sealed, so the database alone never reveals it.
type providerKeyDoc struct {
	ID       string    `bson:"_id"`
	Provider string    `bson:"provider"`
	Sealed   string    `bson:"key"`
	Order    int       `bson:"order"`
	AddedAt  time.Time `bson:"addedAt"`
}

func readSavedKeysDB() map[string][]string {
	out := map[string][]string{}
	ctx, cancel := dbctx()
	defer cancel()
	cur, err := coll(colProviderKeys).Find(ctx, bson.M{})
	if err != nil {
		Logf("db", "reading saved keys: %v", err)
		return out
	}
	var docs []providerKeyDoc
	if cur.All(ctx, &docs) != nil {
		return out
	}
	sort.Slice(docs, func(i, j int) bool { return docs[i].Order < docs[j].Order })
	for _, d := range docs {
		if _, ok := ProviderByID(d.Provider); !ok {
			continue
		}
		if k, err := openSecret(d.Sealed); err == nil && k != "" {
			out[d.Provider] = append(out[d.Provider], k)
		}
	}
	return out
}

// Replaces the saved set: keys no longer listed are deleted, the rest keep their position.
func writeSavedKeysDB(keys map[string][]string) error {
	ctx, cancel := dbctx()
	defer cancel()
	keep := []string{}
	for provider, list := range keys {
		for i, k := range list {
			id := provider + ":" + KeyID(k)
			keep = append(keep, id)
			var existing providerKeyDoc
			if coll(colProviderKeys).FindOne(ctx, bson.M{"_id": id}).Decode(&existing) == nil {
				if _, err := coll(colProviderKeys).UpdateOne(ctx, bson.M{"_id": id}, bson.M{"$set": bson.M{"order": i}}); err != nil {
					return err
				}
				continue
			}
			sealed, err := sealSecret(k)
			if err != nil {
				return err
			}
			doc := providerKeyDoc{ID: id, Provider: provider, Sealed: sealed, Order: i, AddedAt: time.Now()}
			if _, err := coll(colProviderKeys).ReplaceOne(ctx, bson.M{"_id": id}, doc, options.Replace().SetUpsert(true)); err != nil {
				return err
			}
		}
	}
	_, err := coll(colProviderKeys).DeleteMany(ctx, bson.M{"_id": bson.M{"$nin": keep}})
	return err
}
