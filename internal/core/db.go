package core

import (
	"context"
	"errors"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// MongoDB is the system of record when MONGODB_URI is set; otherwise the JSON files under DataDir are.
var (
	mdb     *mongo.Database
	mclient *mongo.Client
)

const (
	colUsers        = "users"
	colIdentities   = "identities"
	colProjects     = "projects"
	colProviderKeys = "provider_keys"
	colMeta         = "meta"
)

func DBEnabled() bool { return mdb != nil }

func coll(name string) *mongo.Collection { return mdb.Collection(name) }

func dbctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 10*time.Second)
}

// Connects, checks the server answers, and creates the indexes every query relies on.
func OpenDB(uri, name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	client, err := mongo.Connect(options.Client().ApplyURI(uri).SetAppName("jr-architect").SetServerSelectionTimeout(15 * time.Second))
	if err != nil {
		return fmt.Errorf("mongodb: %w", err)
	}
	if err := client.Ping(ctx, nil); err != nil {
		client.Disconnect(context.Background())
		return fmt.Errorf("mongodb did not answer: %w", err)
	}
	mclient, mdb = client, client.Database(name)
	if err := ensureIndexes(ctx); err != nil {
		CloseDB()
		return err
	}
	return nil
}

func CloseDB() {
	if mclient != nil {
		mclient.Disconnect(context.Background())
	}
	mclient, mdb = nil, nil
}

func ensureIndexes(ctx context.Context) error {
	indexes := map[string][]mongo.IndexModel{
		colUsers:        {{Keys: bson.D{{Key: "email", Value: 1}}}},
		colIdentities:   {{Keys: bson.D{{Key: "user", Value: 1}}}},
		colProjects:     {{Keys: bson.D{{Key: "owner", Value: 1}, {Key: "savedAt", Value: -1}}}},
		colProviderKeys: {{Keys: bson.D{{Key: "provider", Value: 1}, {Key: "order", Value: 1}}}},
	}
	for name, models := range indexes {
		if _, err := coll(name).Indexes().CreateMany(ctx, models); err != nil {
			return fmt.Errorf("mongodb index on %s: %w", name, err)
		}
	}
	return nil
}

func isNoDoc(err error) bool { return errors.Is(err, mongo.ErrNoDocuments) }

// Records that a one-time step ran; reports false when it had already been recorded.
func markOnce(id string) (bool, error) {
	ctx, cancel := dbctx()
	defer cancel()
	_, err := coll(colMeta).InsertOne(ctx, bson.M{"_id": id, "at": time.Now()})
	if mongo.IsDuplicateKeyError(err) {
		return false, nil
	}
	return err == nil, err
}
