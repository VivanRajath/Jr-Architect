package core

import (
	"context"
	"net/http"
)

const (
	LocalUser = "local"
	// The agent service acting for a user whose ownership it has already checked.
	InternalUser = "internal"
)

type userKey struct{}

func UserOf(r *http.Request) string {
	if u, ok := r.Context().Value(userKey{}).(string); ok {
		return u
	}
	return LocalUser
}

func WithUser(r *http.Request, user string) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), userKey{}, user))
}

func CanUse(user, owner string) bool {
	return user == InternalUser || user == owner
}
