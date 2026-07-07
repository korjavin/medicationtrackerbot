package gojaspike

import (
	"database/sql"
	"encoding/json"

	"github.com/dop251/goja"
)

// RecordsPort provides the DB interface to the JS domain
type RecordsPort struct {
	db *sql.DB
	vm *goja.Runtime
}

func NewRecordsPort(db *sql.DB, vm *goja.Runtime) *RecordsPort {
    return &RecordsPort{db: db, vm: vm}
}

func (rp *RecordsPort) Setup(records *goja.Object) {
	records.Set("put", rp.put)
	records.Set("list", rp.list)
	records.Set("del", rp.del)
}

func (rp *RecordsPort) put(call goja.FunctionCall) goja.Value {
	rt := call.Argument(0).String()
	recordObj := call.Argument(1).Export().(map[string]interface{})
	id, ok := recordObj["recordId"].(string)
	if !ok {
		panic("recordId missing")
	}

	dataBytes, _ := json.Marshal(recordObj)
	_, err := rp.db.Exec("INSERT INTO records (type, id, data) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET data = excluded.data", rt, id, string(dataBytes))
	if err != nil {
		panic(err)
	}

	res, _ := rp.vm.RunString("Promise.resolve()")
	return res
}

func (rp *RecordsPort) list(call goja.FunctionCall) goja.Value {
	rt := call.Argument(0).String()

	rows, err := rp.db.Query("SELECT data FROM records WHERE type = ?", rt)
	if err != nil {
		panic(err)
	}
	defer rows.Close()

	var records []interface{}
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			panic(err)
		}
		var rec map[string]interface{}
		if err := json.Unmarshal([]byte(data), &rec); err != nil {
			panic(err)
		}
		records = append(records, rec)
	}

	rp.vm.Set("_tmpList", records)
	res, _ := rp.vm.RunString("Promise.resolve(_tmpList)")
	return res
}

func (rp *RecordsPort) del(call goja.FunctionCall) goja.Value {
	rt := call.Argument(0).String()
	id := call.Argument(1).String()

	_, err := rp.db.Exec("DELETE FROM records WHERE type = ? AND id = ?", rt, id)
	if err != nil {
		panic(err)
	}

	res, _ := rp.vm.RunString("Promise.resolve()")
	return res
}
